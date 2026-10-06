import * as fs from 'fs';
import * as path from 'path';

// scripts/shelly-mcp-server.js is a dependency-free node script shipped as an
// APK asset; when require()d it exports its transport-agnostic handler instead
// of starting a server.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const MODERN = '2026-07-28';

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
type Out = { status: number; headers: Record<string, string>; body: string | null };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeHandler(callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>, extra: Record<string, unknown> = {}) {
  return mcp.createMcpHandler({ token: TOKEN, callTool, initialHoldMs: 5, retryHoldMs: 20, ...extra });
}

function post(handler: { handle: (r: unknown) => Promise<Out> }, body: unknown, headers: Record<string, string> = {}) {
  return handler.handle({ method: 'POST', url: '/mcp', headers: { ...AUTH, ...headers }, body: JSON.stringify(body) });
}

function parse(out: Out) {
  return out.body === null ? null : JSON.parse(out.body);
}

const modernMeta = (version = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

/** A well-formed 2026-07-28 request: body _meta + mirrored headers. */
function modern(handler: Parameters<typeof post>[0], id: number, method: string, params: Record<string, unknown> = {}, headerOverrides: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'mcp-protocol-version': MODERN, 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  return post(handler, { jsonrpc: '2.0', id, method, params: { ...params, _meta: modernMeta() } }, { ...headers, ...headerOverrides });
}

async function legacySession(handler: Parameters<typeof post>[0], protocolVersion = '2025-06-18') {
  const out = await post(handler, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } },
  });
  return { out, sessionId: out.headers['Mcp-Session-Id'] };
}

describe('shelly-mcp-server.js asset parity', () => {
  it('scripts/ copy and the APK asset are byte-identical', () => {
    const root = path.resolve(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(root, 'scripts/shelly-mcp-server.js'), 'utf8'));
  });
});

describe('legacy (initialize handshake) peers', () => {
  it('negotiates the requested legacy version and mints a session', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    for (const v of ['2025-03-26', '2025-06-18', '2025-11-25']) {
      const { out, sessionId } = await legacySession(handler, v);
      expect(out.status).toBe(200);
      expect(sessionId).toBeTruthy();
      expect(parse(out).result.protocolVersion).toBe(v);
      expect(parse(out).result.serverInfo.name).toBe('shelly');
    }
  });

  it('falls back to the newest legacy version for an unknown or modern version in initialize', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    expect(parse((await legacySession(handler, '2024-11-05')).out).result.protocolVersion).toBe('2025-11-25');
    expect(parse((await legacySession(handler, MODERN)).out).result.protocolVersion).toBe('2025-11-25');
  });

  it('serves the full legacy flow: initialized → ping → tools/list → tools/call (blocking, no resultType)', async () => {
    const calls: string[] = [];
    const handler = makeHandler(async (tool) => { calls.push(tool); return { ok: true, data: ['/repo'] }; });
    const { sessionId } = await legacySession(handler);
    const s = { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };

    const initialized = await post(handler, { jsonrpc: '2.0', method: 'notifications/initialized' }, s);
    expect(initialized.status).toBe(202);
    expect(initialized.body).toBeNull();

    // `ping` is removed in 2026-07-28 but legacy clients still send it.
    expect(parse(await post(handler, { jsonrpc: '2.0', id: 2, method: 'ping' }, s)).result).toEqual({});

    const list = parse(await post(handler, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, s));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('run_command');
    expect(list.result.resultType).toBeUndefined();

    const call = parse(await post(handler, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_repos', arguments: {} } }, s));
    expect(call.result).toEqual({ content: [{ type: 'text', text: '["/repo"]' }], isError: false });
    expect(calls).toEqual(['list_repos']);
  });

  it('keeps legacy exec/write calls blocking on one POST (no MRTR)', async () => {
    const approval = deferred<ToolResult>();
    const handler = makeHandler(() => approval.promise);
    const { sessionId } = await legacySession(handler);
    const pending = post(handler, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'ls' } } }, { 'mcp-session-id': sessionId });
    setTimeout(() => approval.resolve({ ok: false, error: 'denied by user (or timed out waiting for a response)' }), 50);
    const res = parse(await pending);
    expect(res.result.isError).toBe(true);
    expect(res.result.resultType).toBeUndefined();
    expect(res.result.requestState).toBeUndefined();
  });

  it('rejects a non-initialize legacy request without a known session', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'bogus' });
    expect(out.status).toBe(400);
    expect(parse(out).error.code).toBe(-32000);
  });

  it('terminates a session on DELETE', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const { sessionId } = await legacySession(handler);
    const del = await handler.handle({ method: 'DELETE', url: '/mcp', headers: { ...AUTH, 'mcp-session-id': sessionId }, body: '' });
    expect(del.status).toBe(200);
    const after = await post(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sessionId });
    expect(after.status).toBe(400);
  });
});

describe('2026-07-28 (stateless) peers', () => {
  it('serves tools/list without initialize, as a CacheableResult with resultType + serverInfo', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await modern(handler, 1, 'tools/list');
    expect(out.status).toBe(200);
    expect(out.headers['Mcp-Session-Id']).toBeUndefined();
    const { result } = parse(out);
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe('private');
    expect(result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('shelly');
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(mcp.TOOLS.map((t: { name: string }) => t.name));
  });

  it('implements server/discover advertising modern + legacy versions', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const { result } = parse(await modern(handler, 'd1' as unknown as number, 'server/discover'));
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(typeof result.ttlMs).toBe('number');
    expect(result.cacheScope).toBe('private');
  });

  it('ignores an Mcp-Session-Id header on modern requests', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await modern(handler, 1, 'tools/list', {}, { 'mcp-session-id': 'stale-from-legacy' });
    expect(out.status).toBe(200);
    expect(out.headers['Mcp-Session-Id']).toBeUndefined();
  });

  it('returns UnsupportedProtocolVersion (-32022, 400) with the supported list', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta('1900-01-01') } },
      { 'mcp-protocol-version': '1900-01-01', 'mcp-method': 'tools/list' });
    expect(out.status).toBe(400);
    const { error } = parse(out);
    expect(error.code).toBe(-32022);
    expect(error.data).toEqual({ supported: mcp.SUPPORTED_VERSIONS, requested: '1900-01-01' });
  });

  it('a dual-era client probing with a modern header but no session gets a modern error, not a legacy one', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    // Header says 2026-07-28 but the body has no _meta → malformed modern request.
    const out = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
    expect(out.status).toBe(400);
    expect(parse(out).error.code).toBe(-32602);
  });

  it('rejects missing clientCapabilities with -32602 / 400', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await post(handler, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
    }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
    expect(out.status).toBe(400);
    expect(parse(out).error.code).toBe(-32602);
  });

  it.each([
    ['missing MCP-Protocol-Version', { 'mcp-protocol-version': undefined as unknown as string }],
    ['mismatched MCP-Protocol-Version', { 'mcp-protocol-version': '2025-11-25' }],
    ['missing Mcp-Method', { 'mcp-method': undefined as unknown as string }],
    ['mismatched Mcp-Method', { 'mcp-method': 'tools/list' }],
    ['missing Mcp-Name', { 'mcp-name': undefined as unknown as string }],
    ['mismatched Mcp-Name', { 'mcp-name': 'list_agents' }],
  ])('rejects %s with HeaderMismatch (-32020, 400) without calling the tool', async (_label, overrides) => {
    const callTool = jest.fn(async () => ({ ok: true, data: [] } as ToolResult));
    const handler = makeHandler(callTool);
    const headers: Record<string, string> = { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'list_repos' };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete headers[k]; else headers[k] = v;
    }
    const out = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_repos', arguments: {}, _meta: modernMeta() } }, headers);
    expect(out.status).toBe(400);
    expect(parse(out).error.code).toBe(-32020);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('accepts a base64-sentinel-encoded Mcp-Name', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: ['/repo'] }));
    const encoded = `=?base64?${Buffer.from('list_repos').toString('base64')}?=`;
    const out = await modern(handler, 1, 'tools/call', { name: 'list_repos', arguments: {} }, { 'mcp-name': encoded });
    expect(out.status).toBe(200);
    expect(parse(out).result.resultType).toBe('complete');
  });

  it('answers removed legacy-only methods (ping) with 404 + -32601', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await modern(handler, 1, 'ping');
    expect(out.status).toBe(404);
    expect(parse(out).error.code).toBe(-32601);
  });

  it('read-only tools/call completes synchronously with resultType complete', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [{ id: 'a' }] }));
    const { result } = parse(await modern(handler, 1, 'tools/call', { name: 'list_agents', arguments: {} }));
    expect(result.resultType).toBe('complete');
    expect(result.isError).toBe(false);
    expect(result.requestState).toBeUndefined();
  });
});

describe('transport hardening (both eras)', () => {
  it('refuses a non-loopback Origin with 403 before anything else', async () => {
    const callTool = jest.fn();
    const handler = makeHandler(callTool);
    const out = await post(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'https://evil.example' });
    expect(out.status).toBe(403);
    const ok = await post(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'http://localhost:6274' });
    expect(ok.status).toBe(200);
  });

  it('requires the bearer token in both eras', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const legacy = await handler.handle({ method: 'POST', url: '/mcp', headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    expect(legacy.status).toBe(401);
    const modernOut = await handler.handle({
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer wrong', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } }),
    });
    expect(modernOut.status).toBe(401);
  });

  it('answers GET on the endpoint with 405 (no standalone SSE stream)', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await handler.handle({ method: 'GET', url: '/mcp', headers: AUTH, body: '' });
    expect(out.status).toBe(405);
  });
});

describe('MRTR mapping of the on-device approval wait (2026-07-28 only)', () => {
  const RUN = { name: 'run_command', arguments: { command: 'echo hi', cwd: '/repo' } };

  it('defers a pending approval via InputRequiredResult (requestState only, never inputRequests) and completes on retry', async () => {
    const approval = deferred<ToolResult>();
    const callTool = jest.fn(() => approval.promise);
    const handler = makeHandler(callTool);

    const first = parse(await modern(handler, 1, 'tools/call', RUN));
    expect(first.result.resultType).toBe('input_required');
    expect(typeof first.result.requestState).toBe('string');
    // The approval belongs to the phone owner — it is never elicited from the peer.
    expect(first.result.inputRequests).toBeUndefined();
    expect(first.result.content).toBeUndefined();

    // Still pending → the retry long-polls, then re-defers with the same state.
    const stillPending = parse(await modern(handler, 2, 'tools/call', { ...RUN, requestState: first.result.requestState }));
    expect(stillPending.result.resultType).toBe('input_required');
    expect(stillPending.result.requestState).toBe(first.result.requestState);

    approval.resolve({ ok: true, data: { stdout: 'hi\n', stderr: '', exitCode: 0 } });
    const done = parse(await modern(handler, 3, 'tools/call', { ...RUN, requestState: first.result.requestState }));
    expect(done.result.resultType).toBe('complete');
    expect(done.result.isError).toBe(false);
    expect(JSON.parse(done.result.content[0].text).stdout).toBe('hi\n');

    // Exactly one on-device request for the whole logical call.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(handler._pendingApprovalCount()).toBe(0);
  });

  it('a denial is returned as a complete error result on retry (fail-closed)', async () => {
    const approval = deferred<ToolResult>();
    const handler = makeHandler(() => approval.promise);
    const first = parse(await modern(handler, 1, 'tools/call', RUN));
    approval.resolve({ ok: false, error: 'denied by user (or timed out waiting for a response)' });
    const done = parse(await modern(handler, 2, 'tools/call', { ...RUN, requestState: first.result.requestState }));
    expect(done.result.resultType).toBe('complete');
    expect(done.result.isError).toBe(true);
    expect(done.result.content[0].text).toMatch(/denied/);
  });

  it('answers immediately (no MRTR) when the bridge settles within the initial hold, e.g. gate disabled', async () => {
    const handler = makeHandler(async () => ({ ok: false, error: 'exec/write tools are disabled' }));
    const { result } = parse(await modern(handler, 1, 'tools/call', RUN));
    expect(result.resultType).toBe('complete');
    expect(result.isError).toBe(true);
    expect(result.requestState).toBeUndefined();
  });

  it('a consumed requestState cannot be replayed', async () => {
    const approval = deferred<ToolResult>();
    const callTool = jest.fn(() => approval.promise);
    const handler = makeHandler(callTool);
    const first = parse(await modern(handler, 1, 'tools/call', RUN));
    approval.resolve({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } });
    await modern(handler, 2, 'tools/call', { ...RUN, requestState: first.result.requestState });
    const replay = await modern(handler, 3, 'tools/call', { ...RUN, requestState: first.result.requestState });
    expect(replay.status).toBe(400);
    expect(parse(replay).error.code).toBe(-32602);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered requestState without starting a new execution', async () => {
    const callTool = jest.fn(() => new Promise<ToolResult>(() => {}));
    const handler = makeHandler(callTool);
    const first = parse(await modern(handler, 1, 'tools/call', RUN));
    const [body, mac] = first.result.requestState.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.e += 10_000_000;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    for (const state of [forged, 'garbage', `${body}.AAAA`, 42]) {
      const out = await modern(handler, 2, 'tools/call', { ...RUN, requestState: state });
      expect(out.status).toBe(400);
      expect(parse(out).error.code).toBe(-32602);
    }
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('rejects a requestState presented with different arguments or a different tool', async () => {
    const callTool = jest.fn(() => new Promise<ToolResult>(() => {}));
    const handler = makeHandler(callTool);
    const first = parse(await modern(handler, 1, 'tools/call', RUN));
    const swapped = await modern(handler, 2, 'tools/call', { name: 'run_command', arguments: { command: 'rm -rf ~', cwd: '/repo' }, requestState: first.result.requestState });
    expect(swapped.status).toBe(400);
    const otherTool = await modern(handler, 3, 'tools/call', { name: 'write_file', arguments: RUN.arguments, requestState: first.result.requestState });
    expect(otherTool.status).toBe(400);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('rejects a requestState minted by another server process (different HMAC key) and after expiry', async () => {
    let clock = 1_000_000;
    const a = makeHandler(() => new Promise<ToolResult>(() => {}), { now: () => clock });
    const b = makeHandler(() => new Promise<ToolResult>(() => {}), { now: () => clock });
    const first = parse(await modern(a, 1, 'tools/call', RUN));
    expect((await modern(b, 2, 'tools/call', { ...RUN, requestState: first.result.requestState })).status).toBe(400);
    clock += 10 * 60_000;
    expect((await modern(a, 3, 'tools/call', { ...RUN, requestState: first.result.requestState })).status).toBe(400);
  });

  it('read-only tools never accept a requestState', async () => {
    const handler = makeHandler(async () => ({ ok: true, data: [] }));
    const out = await modern(handler, 1, 'tools/call', { name: 'list_repos', arguments: {}, requestState: 'x.y' });
    expect(out.status).toBe(400);
  });
});
