/**
 * put_stream_feed (launcher ingress C7): the script pre-check, the TS mirror
 * of the validation, the always-allow rule shape and the RN approval ladder.
 * The feed is tainted external data: no log line, audit line, dialog text or
 * error message may carry its content. Dummy values only.
 */
const mockStreamFeedPut = jest.fn();
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  streamFeedPut: (...a: unknown[]) => mockStreamFeedPut(...a),
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
jest.mock('@/lib/i18n', () => ({
  t: (k: string, p?: Record<string, string>) => (p ? `${k}:${JSON.stringify(p)}` : k),
  tFor: (_l: string, k: string) => k,
}));

import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __setMCPApprovalTimeoutForTests, __setMCPRequestSha256ForTests, setMCPBridgeKey, startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import {
  parseStreamFeedStoreResult, STREAM_FEED_MAX_BYTES, STREAM_FEED_OP, STREAM_FEED_TARGET, utf8ByteLength,
  validateStreamFeedArgs,
} from '@/lib/mcp-stream-feed';
import {
  findAlwaysAllowMatch, isValidAlwaysAllowTarget, isValidPrincipalFor, normalizeTarget, OP_ORIGINS, parseAlwaysAllowStatus,
  TYPED_OPS,
} from '@/lib/mcp-always-allow';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool as bridgeCall, h, OTHER_PRINCIPAL, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

const MARKER = 'FEED-CONTENT-MARKER-7f3a';
const sha = (s: string) => nodeCrypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const feedArgs = (feedJson: string, over: Record<string, unknown> = {}) => ({
  feedJson, expectedSha256: sha(feedJson), expectedBytes: Buffer.byteLength(feedJson, 'utf8'), ...over,
});
const FEED = JSON.stringify({ v: 1, updatedAt: '2026-11-25T00:00:00Z', items: [
  { id: 'a', source: 'x', ts: '2026-11-25T00:00:00Z', author: 'someone', text: `${MARKER} hello` },
  { id: 'b', source: 'bsky', ts: '2026-11-24T23:00:00Z', author: 'other', text: 'こんにちは 🌸' },
] });

/** A feed of exactly `bytes` UTF-8 bytes built from 3-byte characters. */
function feedOfBytes(bytes: number): string {
  const head = '{"v":1,"s":"';
  const tail = '"}';
  const room = bytes - head.length - tail.length;
  const s = `${head}${'日'.repeat(Math.floor(room / 3))}${'a'.repeat(room % 3)}${tail}`;
  expect(Buffer.byteLength(s, 'utf8')).toBe(bytes);
  return s;
}

/** The TS mirror and the script pre-check give the same code (null = passes). */
function codes(args: unknown): [string | null, string | null] {
  const ts = validateStreamFeedArgs(args);
  const script = server.streamFeedPrecheck(args);
  return ['code' in ts ? ts.code : null, script ? script.code : null];
}

// ── validation (TS mirror and script pre-check, same order and codes) ──────

describe('validation', () => {
  it('accepts a v1 feed and reports bytes, sha256 and the item count', () => {
    const r = validateStreamFeedArgs(feedArgs(FEED));
    expect(r).toEqual({ ok: true, args: feedArgs(FEED), bytes: Buffer.byteLength(FEED, 'utf8'), sha256: sha(FEED), items: 2 });
    expect(server.streamFeedPrecheck(feedArgs(FEED))).toBeNull();
  });

  it('item count is absent when items is not an array', () => {
    const f = '{"v":1,"items":{"a":1}}';
    const r = validateStreamFeedArgs(feedArgs(f));
    expect(r.ok).toBe(true);
    expect('items' in r).toBe(false);
  });

  it('the UTF-8 length counts multibyte and supplementary characters like node', () => {
    for (const s of ['', 'a', 'é', '日本', '🌸', 'a🌸b日']) expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'));
  });

  it.each([
    ['not an object', 'x'],
    ['an array', [1]],
    ['null', null],
    ['a missing argument', { feedJson: FEED, expectedSha256: sha(FEED) }],
    ['an unknown argument', { ...feedArgs(FEED), extra: 1 }],
    ['feedJson not a string', { ...feedArgs(FEED), feedJson: { v: 1 } }],
    ['feedJson with a lone surrogate', { ...feedArgs(FEED), feedJson: '{"v":1,"s":"\ud800"}' }],
    ['expectedSha256 upper case', { ...feedArgs(FEED), expectedSha256: sha(FEED).toUpperCase() }],
    ['expectedSha256 short', { ...feedArgs(FEED), expectedSha256: 'ab' }],
    ['expectedBytes a string', { ...feedArgs(FEED), expectedBytes: '10' }],
    ['expectedBytes fractional', { ...feedArgs(FEED), expectedBytes: 10.5 }],
    ['expectedBytes 0', { ...feedArgs(FEED), expectedBytes: 0 }],
    ['expectedBytes over the cap', { ...feedArgs(FEED), expectedBytes: STREAM_FEED_MAX_BYTES + 1 }],
  ])('invalid_params: %s', (_name, args) => {
    expect(codes(args)).toEqual(['invalid_params', 'invalid_params']);
  });

  it('boundary: 49152 bytes of multibyte text passes, 49153 is too_large', () => {
    const at = feedOfBytes(STREAM_FEED_MAX_BYTES);
    expect(codes(feedArgs(at))).toEqual([null, null]);
    const over = feedOfBytes(STREAM_FEED_MAX_BYTES + 1);
    expect(codes(feedArgs(over, { expectedBytes: STREAM_FEED_MAX_BYTES }))).toEqual(['too_large', 'too_large']);
  });

  it('too_large comes before size_mismatch and digest_mismatch', () => {
    const over = feedOfBytes(STREAM_FEED_MAX_BYTES + 3);
    expect(codes({ feedJson: over, expectedSha256: 'f'.repeat(64), expectedBytes: 10 })).toEqual(['too_large', 'too_large']);
  });

  it('size_mismatch (counted in UTF-8 bytes, not UTF-16 units) comes before digest_mismatch', () => {
    const f = '{"v":1,"s":"日本🌸"}';
    expect(codes(feedArgs(f, { expectedBytes: f.length }))).toEqual(['size_mismatch', 'size_mismatch']);
    expect(codes(feedArgs(f, { expectedBytes: Buffer.byteLength(f) + 1, expectedSha256: 'f'.repeat(64) }))).toEqual(['size_mismatch', 'size_mismatch']);
  });

  it('digest_mismatch comes before invalid_feed', () => {
    expect(codes(feedArgs(FEED, { expectedSha256: '0'.repeat(64) }))).toEqual(['digest_mismatch', 'digest_mismatch']);
    expect(codes(feedArgs('not json', { expectedSha256: '0'.repeat(64) }))).toEqual(['digest_mismatch', 'digest_mismatch']);
  });

  it.each([
    ['bad JSON', '{"v":1,'],
    ['an array', '[{"v":1}]'],
    ['null', 'null'],
    ['a string', '"v"'],
    ['v as a string', '{"v":"1"}'],
    ['v 2', '{"v":2}'],
    ['v missing', '{"items":[]}'],
    ['v true', '{"v":true}'],
  ])('invalid_feed: %s', (_name, feedJson) => {
    expect(codes(feedArgs(feedJson))).toEqual(['invalid_feed', 'invalid_feed']);
  });

  it('no message ever carries feed content', () => {
    const cases = [
      feedArgs(`{"v":2,"s":"${MARKER}"}`),
      feedArgs(`{"v":1,"s":"${MARKER}"`),
      feedArgs(`{"v":1,"s":"${MARKER}"}`, { expectedSha256: '0'.repeat(64) }),
      feedArgs(`{"v":1,"s":"${MARKER}"}`, { expectedBytes: 3 }),
    ];
    for (const c of cases) {
      const ts = validateStreamFeedArgs(c);
      expect(JSON.stringify(ts)).not.toContain(MARKER);
      expect(JSON.stringify(server.streamFeedPrecheck(c))).not.toContain(MARKER);
    }
  });
});

describe('parseStreamFeedStoreResult', () => {
  const exp = { sha256: sha(FEED), bytes: 10 };
  it('accepts a success naming the expected sha256 and bytes', () => {
    expect(parseStreamFeedStoreResult(JSON.stringify({ ok: true, sha256: exp.sha256, bytes: 10, receivedAt: 5, items: 2 }), exp))
      .toEqual({ ok: true, sha256: exp.sha256, bytes: 10, receivedAt: 5, items: 2 });
    expect(parseStreamFeedStoreResult(JSON.stringify({ ok: false, code: 'store_failed' }), exp)).toEqual({ ok: false, code: 'store_failed' });
  });
  it.each([
    null, 'x', '[]', '{"ok":false,"code":"weird"}',
    JSON.stringify({ ok: true, sha256: 'f'.repeat(64), bytes: 10, receivedAt: 5 }),
    JSON.stringify({ ok: true, sha256: sha(FEED), bytes: 11, receivedAt: 5 }),
    JSON.stringify({ ok: true, sha256: sha(FEED), bytes: 10 }),
    JSON.stringify({ ok: true, sha256: sha(FEED), bytes: 10, receivedAt: 5, items: -1 }),
  ])('refuses %s', (raw) => {
    expect(parseStreamFeedStoreResult(raw, exp)).toBeNull();
  });
});

// ── script: listing, routing, pre-check before enqueueing ──────────────────

describe('script', () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name);
  const ingress = { principal: TEST_PRINCIPAL, clientNameSelfReported: 'c' };
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-feed-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const queued = () => ['requests', 'typed-requests', 'raw-requests']
    .flatMap((d) => (fs.existsSync(path.join(dir, d)) ? fs.readdirSync(path.join(dir, d)) : []));

  it('is listed only with typedOps (exec alone does not list it)', () => {
    expect(names(server.availableTools({ typedOps: true }))).toContain('put_stream_feed');
    expect(names(server.availableTools({ exec: true }))).not.toContain('put_stream_feed');
    expect(names(server.availableTools({}))).not.toContain('put_stream_feed');
    expect(server.TYPED_OP_TOOLS.has('put_stream_feed')).toBe(true);
    expect(server.APPROVAL_TOOLS.has('put_stream_feed')).toBe(true);
    expect(server.TYPED_REQUEST_TOOLS.has('put_stream_feed')).toBe(true);
    expect(server.requestDirName('put_stream_feed')).toBe('typed-requests');
  });

  it('schema: strict, three required arguments, byte cap', () => {
    const tool = server.TOOLS.find((t: { name: string }) => t.name === 'put_stream_feed');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['feedJson', 'expectedSha256', 'expectedBytes']);
    expect(tool.inputSchema.required).toEqual(['feedJson', 'expectedSha256', 'expectedBytes']);
    expect(tool.inputSchema.properties.expectedSha256.pattern).toBe('^[0-9a-f]{64}$');
    expect(tool.inputSchema.properties.expectedBytes).toMatchObject({ type: 'integer', minimum: 1, maximum: STREAM_FEED_MAX_BYTES });
    expect(server.STREAM_FEED_MAX_BYTES).toBe(STREAM_FEED_MAX_BYTES);
  });

  it('a valid feed is enqueued in typed-requests/ only', async () => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool('put_stream_feed', feedArgs(FEED), ingress);
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'typed-requests', typed[0]), 'utf8'));
    expect(body.args).toEqual(feedArgs(FEED));
    const answer = { ok: true, data: { stored: true } };
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify(answer));
    await expect(pending).resolves.toEqual(answer);
  });

  it('the 49152-byte multibyte feed fits the request cap and is enqueued', async () => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool('put_stream_feed', feedArgs(feedOfBytes(STREAM_FEED_MAX_BYTES)), ingress);
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    expect(fs.statSync(path.join(dir, 'typed-requests', typed[0])).size).toBeLessThanOrEqual(server.TYPED_REQUEST_MAX_BYTES);
    const callId = typed[0].replace(/\.json$/, '');
    fs.writeFileSync(path.join(dir, 'results', `${callId}.json`), JSON.stringify({ ok: true, data: null }));
    await pending;
  });

  it.each([
    ['invalid_params', { ...feedArgs(FEED), extra: true }],
    ['too_large', feedArgs(feedOfBytes(STREAM_FEED_MAX_BYTES + 1), { expectedBytes: STREAM_FEED_MAX_BYTES })],
    ['size_mismatch', feedArgs(FEED, { expectedBytes: 5 })],
    ['digest_mismatch', feedArgs(FEED, { expectedSha256: '0'.repeat(64) })],
    ['invalid_feed', feedArgs('{"v":2}')],
  ])('refuses %s at once, before anything is enqueued', async (code, args) => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const r = await callTool('put_stream_feed', args, ingress);
    expect(r).toMatchObject({ ok: false, code });
    expect(queued()).toEqual([]);
    expect(server.toolResultBody(r).content[0].text).toMatch(new RegExp(`^Error: \\[${code}\\] `));
  });

  it('refuses too_large when escaping inflates the signed request past 64 KiB', async () => {
    // 40,000 bytes of JSON-escaped backslashes double when the request is serialized.
    const f = `{"v":1,"s":"${'\\\\'.repeat(20_000)}"}`;
    expect(Buffer.byteLength(f)).toBeLessThanOrEqual(STREAM_FEED_MAX_BYTES);
    expect(server.streamFeedPrecheck(feedArgs(f))).toBeNull();
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const r = await callTool('put_stream_feed', feedArgs(f), ingress);
    expect(r).toMatchObject({ ok: false, code: 'too_large' });
    expect(queued()).toEqual([]);
  });

  it('the size refusal helper uses the native cap exactly', () => {
    expect(server.TYPED_REQUEST_MAX_BYTES).toBe(64 * 1024);
    expect(server.streamFeedRequestTooLarge('x'.repeat(64 * 1024))).toBeNull();
    expect(server.streamFeedRequestTooLarge('x'.repeat(64 * 1024 + 1))).toMatchObject({ code: 'too_large' });
  });
});

// ── always-allow rule shape (TS mirror of McpAlwaysAllowStore) ─────────────

describe('always-allow', () => {
  const LAUNCHER = `launcher:${TEST_PRINCIPAL}`;
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r_00000000000000f1', principal: TEST_PRINCIPAL, op: 'put_stream_feed', target: 'stream-feed', label: 'feed', createdAt: 1, ...over,
  });

  it('is a typed op of the MCP origin with the one target stream-feed', () => {
    expect(TYPED_OPS).toContain('put_stream_feed');
    expect(OP_ORIGINS.put_stream_feed).toBe('mcp');
    expect(STREAM_FEED_OP).toBe('put_stream_feed');
    expect(STREAM_FEED_TARGET).toBe('stream-feed');
    expect(isValidAlwaysAllowTarget('put_stream_feed', 'stream-feed')).toBe(true);
    for (const bad of ['stream-feed2', 'Stream-feed', 'stream-feed:x', 'agent:x', 'hayato', '', 'stream_feed']) {
      expect(isValidAlwaysAllowTarget('put_stream_feed', bad)).toBe(false);
    }
    expect(normalizeTarget('put_stream_feed', feedArgs(FEED))).toBe('stream-feed');
  });

  it('a rule names an MCP principal, never a launcher principal', () => {
    expect(isValidPrincipalFor('put_stream_feed', TEST_PRINCIPAL)).toBe(true);
    expect(isValidPrincipalFor('put_stream_feed', LAUNCHER)).toBe(false);
    const parsed = parseAlwaysAllowStatus(JSON.stringify({ version: 1, status: 'ok', rules: [rule()] }));
    expect(parsed).toMatchObject({ status: 'ok', rules: [rule()] });
    for (const bad of [rule({ principal: LAUNCHER }), rule({ target: 'other' })]) {
      expect(parseAlwaysAllowStatus(JSON.stringify({ version: 1, status: 'ok', rules: [bad] })).status).toBe('unreadable');
    }
  });

  it('matches with bind null only for its principal', () => {
    const rules = [rule()] as never[];
    expect(findAlwaysAllowMatch(rules, TEST_PRINCIPAL, 'put_stream_feed', 'stream-feed', null)).toMatchObject({ id: 'r_00000000000000f1' });
    expect(findAlwaysAllowMatch(rules, OTHER_PRINCIPAL, 'put_stream_feed', 'stream-feed', null)).toBeNull();
    expect(findAlwaysAllowMatch(rules, LAUNCHER, 'put_stream_feed', 'stream-feed', null)).toBeNull();
  });
});

// ── RN approval ladder (handed-off request) ────────────────────────────────

describe('RN ladder', () => {
  const tool = 'put_stream_feed';
  const current = () => useMcpApprovalStore.getState().current;
  const call = (args: Record<string, unknown> = feedArgs(FEED), opts: Record<string, unknown> = {}) =>
    bridgeCall(tool, args, { handoff: 'valid', ...opts });
  const stored = () => JSON.stringify({ ok: true, sha256: sha(FEED), bytes: Buffer.byteLength(FEED), receivedAt: 1_764_000_000_000, items: 2 });
  const audits = () => h.audits.map(({ agentId, json }) => {
    expect(agentId).toBeNull();
    expect(Object.keys(json).sort()).toEqual(['code', 'event', 'kind', 'principal']);
    expect(json).toMatchObject({ kind: 'mcp_stream_feed', event: 'mcp_stream_feed', principal: TEST_PRINCIPAL });
    return json.code;
  });
  const addRule = (over: Record<string, unknown> = {}) => {
    const r = { id: 'r_00000000000000f1', principal: TEST_PRINCIPAL, op: tool, target: 'stream-feed', label: 'feed', createdAt: 1, ...over };
    h.rules.push(r as never);
    return r;
  };
  const noContentLeaked = () => {
    for (const l of h.logs) expect(l).not.toContain(MARKER);
    for (const a of h.audits) expect(JSON.stringify(a.json)).not.toContain(MARKER);
    for (const t of h.toasts) expect(t).not.toContain(MARKER);
  };

  beforeEach(() => {
    resetHarness();
    mockStreamFeedPut.mockReset();
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
  });
  afterEach(() => {
    noContentLeaked();
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  async function dialog(decision: 'once' | 'deny' | 'always') {
    const pending = call();
    await waitFor(() => current() !== null);
    const req = current()!;
    expect(req).toMatchObject({ kind: tool, summary: 'mcp.approval_stream_feed' });
    expect(req.alwaysAllowable).toEqual({ op: 'put_stream_feed', targetLabel: 'mcp.stream_feed_rule_label' });
    expect(req.detail).toBe(`mcp.approval_stream_feed_detail:${JSON.stringify({ bytes: String(Buffer.byteLength(FEED)), sha: sha(FEED).slice(0, 12) })}`);
    expect(`${req.summary}${req.detail}`).not.toContain(MARKER);
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
    useMcpApprovalStore.getState().respond(req.id, decision);
    return pending;
  }

  it('is refused without a handoff token (typed requests arrive only via native)', async () => {
    expect(await call(feedArgs(FEED), { handoff: 'none' })).toBeNull();
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
  });

  it('a matching rule stores without a dialog, in the background too', async () => {
    addRule();
    h.appState.currentState = 'background';
    mockStreamFeedPut.mockResolvedValueOnce(stored());
    expect(await call()).toEqual({ ok: true, data: {
      stored: true, sha256: sha(FEED), bytes: Buffer.byteLength(FEED), receivedAt: 1_764_000_000_000, untrusted: true,
    } });
    expect(current()).toBeNull();
    expect(mockStreamFeedPut).toHaveBeenCalledWith(FEED, sha(FEED), Buffer.byteLength(FEED), TEST_PRINCIPAL, expect.any(Number));
    expect(audits()).toEqual(['always_allowed']);
  });

  it('a rule of another client does not match', async () => {
    addRule({ principal: OTHER_PRINCIPAL });
    h.appState.currentState = 'background';
    expect(await call()).toMatchObject({ ok: false, code: 'not_attended' });
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
  });

  it('the "Skip all approvals" switch does not apply: background → not_attended', async () => {
    h.settings.approveAllWithoutAsking = true;
    h.appState.currentState = 'background';
    expect(await call()).toMatchObject({ ok: false, code: 'not_attended' });
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
    expect(audits()).toEqual(['not_attended']);
  });

  it('the "Skip all approvals" switch does not apply: foreground still asks', async () => {
    h.settings.approveAllWithoutAsking = true;
    expect(await dialog('deny')).toMatchObject({ ok: false, code: 'denied' });
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
    expect(audits()).toEqual(['approval_requested', 'denied']);
  });

  it('not in the foreground, no rule: not_attended at once, no dialog queued', async () => {
    h.appState.currentState = 'background';
    expect(await call()).toMatchObject({ ok: false, code: 'not_attended' });
    expect(current()).toBeNull();
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
  });

  it('deny stores nothing', async () => {
    expect(await dialog('deny')).toMatchObject({ ok: false, code: 'denied' });
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
    expect(h.rules).toEqual([]);
  });

  it('once stores and writes no rule', async () => {
    mockStreamFeedPut.mockResolvedValueOnce(stored());
    expect(await dialog('once')).toMatchObject({ ok: true, data: { stored: true, untrusted: true } });
    expect(h.rules).toEqual([]);
    expect(audits()).toEqual(['approval_requested']);
  });

  it('always adds the rule (principal × put_stream_feed × stream-feed, no bind) and stores; the next call needs no tap', async () => {
    mockStreamFeedPut.mockResolvedValue(stored());
    expect(await dialog('always')).toMatchObject({ ok: true, data: { stored: true } });
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({ principal: TEST_PRINCIPAL, op: 'put_stream_feed', target: 'stream-feed', label: 'mcp.stream_feed_rule_label' });
    expect(h.rules[0].bind).toBeUndefined();
    expect(audits()).toEqual(['approval_requested', 'always_allow_saved']);
    h.audits = [];
    h.appState.currentState = 'background';
    expect(await call()).toMatchObject({ ok: true });
    expect(mockStreamFeedPut).toHaveBeenCalledTimes(2);
    expect(audits()).toEqual(['always_allowed']);
  });

  it('a rule that cannot be saved stores once and shows a toast', async () => {
    h.addAnswer = { ok: false, code: 'full' };
    mockStreamFeedPut.mockResolvedValueOnce(stored());
    expect(await dialog('always')).toMatchObject({ ok: true });
    expect(h.rules).toEqual([]);
    expect(h.toasts).toEqual(['mcp.always_allow_not_saved_stream_feed']);
    expect(audits()).toEqual(['approval_requested', 'always_allow_not_saved']);
  });

  it('STOP-ALL refuses (halted) before the rule, the dialog and native', async () => {
    addRule();
    h.halted = true;
    expect(await call()).toMatchObject({ ok: false, code: 'halted' });
    expect(current()).toBeNull();
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
    expect(audits()).toEqual(['halted']);
  });

  it('STOP-ALL turned on during the dialog refuses before native', async () => {
    const pending = call();
    await waitFor(() => current() !== null);
    h.halted = true;
    useMcpApprovalStore.getState().respond(current()!.id, 'once');
    expect(await pending).toMatchObject({ ok: false, code: 'halted' });
    expect(mockStreamFeedPut).not.toHaveBeenCalled();
  });

  it('typed ops off: disabled', async () => {
    addRule();
    h.settings.mcpTypedOpsEnabled = false;
    expect(await call()).toMatchObject({ ok: false, code: 'disabled' });
    expect(audits()).toEqual(['disabled']);
  });

  it('bad arguments are refused with the validation code and nothing is asked', async () => {
    expect(await call(feedArgs(FEED, { expectedSha256: '0'.repeat(64) }))).toMatchObject({ ok: false, code: 'digest_mismatch' });
    expect(await call(feedArgs('{"v":2}'))).toMatchObject({ ok: false, code: 'invalid_feed' });
    expect(current()).toBeNull();
    expect(audits()).toEqual(['digest_mismatch', 'invalid_feed']);
  });

  it('a native refusal is passed on (the previous feed is kept)', async () => {
    addRule();
    mockStreamFeedPut.mockResolvedValueOnce(JSON.stringify({ ok: false, code: 'store_failed' }));
    expect(await call()).toMatchObject({ ok: false, code: 'store_failed' });
  });

  it('a malformed native answer or an exception is native_error', async () => {
    addRule();
    mockStreamFeedPut.mockResolvedValueOnce(JSON.stringify({ ok: true, sha256: 'f'.repeat(64), bytes: 1, receivedAt: 1 }));
    expect(await call()).toMatchObject({ ok: false, code: 'native_error' });
    mockStreamFeedPut.mockRejectedValueOnce(new Error(MARKER));
    expect(await call()).toMatchObject({ ok: false, code: 'native_error' });
  });

  it('a dialog timeout is denied', async () => {
    __setMCPApprovalTimeoutForTests(30);
    try {
      expect(await call()).toMatchObject({ ok: false, code: 'denied' });
      expect(mockStreamFeedPut).not.toHaveBeenCalled();
    } finally {
      __setMCPApprovalTimeoutForTests(null);
    }
  });
});

describe('RN ladder without the native store', () => {
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

  it('a build without streamFeedPut answers native_error before asking', async () => {
    const native = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
    const saved = native.streamFeedPut;
    delete native.streamFeedPut;
    try {
      expect(await bridgeCall('put_stream_feed', feedArgs(FEED), { handoff: 'valid' })).toMatchObject({ ok: false, code: 'native_error' });
      expect(useMcpApprovalStore.getState().current).toBeNull();
      expect(h.audits.map((a) => a.json.code)).toEqual(['native_error']);
    } finally {
      native.streamFeedPut = saved;
    }
  });
});
