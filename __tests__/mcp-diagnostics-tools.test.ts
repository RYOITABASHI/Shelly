/**
 * MCP diagnostics tools, RN side (lib/mcp-server-bridge.ts): read_logs and
 * get_settings are refused while settings.mcpDiagnosticsEnabled is off, and
 * get_settings never returns a secret-named setting; device_status answers
 * from a live native reading when the server had to fall back to the queue.
 */
const mockFiles = new Map<string, string>();
const mockSettings: Record<string, unknown> = {};
const mockDeviceStatus = jest.fn(async (): Promise<unknown> => ({
  capturedAtMs: Date.parse('2026-11-15T10:00:00.000Z'),
  battery: { level: 81, charging: true, plugged: 'usb', status: 'charging' },
  thermal: { status: 'none' },
  memory: { availBytes: 3, totalBytes: 8, lowMemory: false },
  storage: { volume: 'app-internal', freeBytes: 10, totalBytes: 100 },
  app: { versionName: '9.9.9', versionCode: 999 },
  uptime: { deviceMs: 1000, appProcessMs: 500 },
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/home-root/',
  readDirectoryAsync: jest.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...mockFiles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'));
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const v = mockFiles.get(uri);
    if (v === undefined) throw new Error('ENOENT ' + uri);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(`${uri}/`)) mockFiles.delete(k);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  }),
}));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/settings-store', () => ({ useSettingsStore: { getState: () => ({ settings: mockSettings }) } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { getDeviceStatus: (...a: unknown[]) => (mockDeviceStatus as any)(...a) },
}));
const mockExecCommand = jest.fn(async (_cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({ stdout: '', stderr: '', exitCode: 0 }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...a: unknown[]) => (mockExecCommand as any)(...a) }));
jest.mock('@/lib/agent-user-policy-store', () => ({ getCachedUserPolicy: () => null, getCachedUserPolicyPin: () => null, loadUserPolicy: jest.fn() }));
// The real debug-logger: its lines must land in the read_logs ring.

import * as nodeCrypto from 'crypto';
import {
  __setMCPRequestSha256ForTests,
  __setMCPSnapshotSha256ForTests,
  capLogLines,
  deviceSectionFromNative,
  bundleFingerprint,
  filterLogcatLines,
  READ_LOGS_MAX_BYTES,
  redactForMcp,
  redactSettingsForMcp,
  setMCPBridgeKey,
  signSnapshot,
  startMCPPoller,
  startMCPSnapshotPublisher,
  stopMCPPoller,
  stopMCPSnapshotPublisher,
} from '@/lib/mcp-server-bridge';
import { logInfo } from '@/lib/debug-logger';
import { __clearDebugLogForTests, DEBUG_LOG_CAPACITY, getDebugLogEntries } from '@/lib/debug-log-buffer';
import { TEST_BRIDGE_KEY, nodeSha256, signedRequest } from './helpers/mcp-signed-request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

const HOME = '/data/home-root/home';
const QUEUE = `file://${HOME}/.shelly-mcp-queue`;
const REQUESTS = `${QUEUE}/requests`;
const RESULTS = `${QUEUE}/results`;

// Planted secrets: none of these values may ever appear in a get_settings result.
const PLANTED = {
  geminiApiKey: 'PLANTED-gemini-value-1',
  telegramBotToken: 'PLANTED-telegram-value-2',
  mySecretThing: 'PLANTED-secret-value-3',
  adminPassword: 'PLANTED-password-value-4',
  oauthCredential: 'PLANTED-credential-value-5',
};

beforeAll(() => {
  __setMCPRequestSha256ForTests(nodeSha256);
  __setMCPSnapshotSha256ForTests(nodeSha256);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
});

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    fontSize: 14,
    terminalTheme: 'case-file',
    mcpServerEnabled: true,
    mcpDiagnosticsEnabled: false,
    ...PLANTED,
    gemini: { model: 'gemini-x', apiKey: 'PLANTED-nested-value-6' },
    localLlmUrl: 'http://127.0.0.1:8080/?k=sk-ant-abcdefghijklmnopqrstuvwxyz0123',
  });
  __clearDebugLogForTests();
});

afterEach(() => {
  stopMCPPoller();
  stopMCPSnapshotPublisher();
  mockFiles.clear();
  mockExecCommand.mockClear();
  mockDeviceStatus.mockClear();
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let seq = 0;
async function call(tool: string, args: Record<string, unknown> = {}) {
  const callId = `d${++seq}`;
  mockFiles.set(`${REQUESTS}/${callId}.json`, await signedRequest(callId, tool, args));
  startMCPPoller();
  const resultUri = `${RESULTS}/${callId}.json`;
  await waitFor(() => mockFiles.has(resultUri));
  return JSON.parse(mockFiles.get(resultUri)!);
}

describe('diagnostics toggle (mcpDiagnosticsEnabled) — RN-side refusal', () => {
  it.each(['read_logs', 'get_settings'])('refuses %s while the toggle is off, with a clear "disabled" error', async (tool) => {
    const result = await call(tool);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`${tool} is disabled`);
    expect(result.error).toContain('MCP: Allow diagnostics');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('serves both once the toggle is on', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    expect((await call('get_settings')).ok).toBe(true);
    expect((await call('read_logs')).ok).toBe(true);
  });
});

describe('get_settings secret denylist', () => {
  it('withholds every planted secret-named setting (top level and nested) and returns the rest', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    const result = await call('get_settings');
    expect(result.ok).toBe(true);
    const text = JSON.stringify(result.data);
    for (const value of [...Object.values(PLANTED), 'PLANTED-nested-value-6']) {
      expect(text).not.toContain(value);
    }
    expect(result.data.withheldKeys).toEqual(expect.arrayContaining([...Object.keys(PLANTED), 'gemini.apiKey']));
    expect(result.data.settings.fontSize).toBe(14);
    expect(result.data.settings.terminalTheme).toBe('case-file');
    expect(result.data.settings.gemini).toEqual({ model: 'gemini-x' });
    // A secret-shaped value under an innocuous name is redacted too.
    expect(result.data.settings.localLlmUrl).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('matches the denylist case-insensitively (pure)', () => {
    const { settings, withheldKeys } = redactSettingsForMcp({ API_KEY: 'a', AccessTOKEN: 'b', PassWord: 'c', SECRET: 'd', Credentials: 'e', keep: 1 });
    expect(settings).toEqual({ keep: 1 });
    expect(withheldKeys).toEqual(['API_KEY', 'AccessTOKEN', 'Credentials', 'PassWord', 'SECRET']);
  });

  it('withholds pwd / pass-word spellings at any depth, including inside arrays', () => {
    const { settings, withheldKeys } = redactSettingsForMcp({
      smtp: [{ host: 'mail.example', pwd: 'PLANTED-pwd-1' }],
      'pass-word': 'PLANTED-pass-word-2',
      nested: { pass_word: 'PLANTED-pass_word-3', SMTP_PWD: 'PLANTED-pwd-4', list: [[{ 'Pass-Word': 'PLANTED-pass-word-5' }]] },
      fontSize: 14,
    });
    expect(JSON.stringify(settings)).not.toMatch(/PLANTED-/);
    expect(withheldKeys).toEqual(['nested.SMTP_PWD', 'nested.list[0][0].Pass-Word', 'nested.pass_word', 'pass-word', 'smtp[0].pwd']);
    expect(settings).toEqual({ smtp: [{ host: 'mail.example' }], nested: { list: [[{}]] }, fontSize: 14 });
  });
});

describe('redactForMcp (shape-based passes on top of redact-secrets)', () => {
  it.each([
    ['URL userinfo', 'https://alice:plain-password@host.example/v1', 'plain-password'],
    ['secret-named query parameter', 'https://host.example/v1?token=opaque-token-value&x=1', 'opaque-token-value'],
    ['Authorization header', 'Authorization: Bearer opaque-token-value', 'opaque-token-value'],
    ['JSON password field', '{"user":"a","password":"hunter2-value"}', 'hunter2-value'],
    ['JSON token field', '{"accessToken": "opaque-json-value"}', 'opaque-json-value'],
    ['Telegram bot token URL', 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ/getMe', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ'],
    ['header-style key', 'X-Api-Key: opaque-header-value', 'opaque-header-value'],
    ['single-quoted assignment', "password='hunter2'", 'hunter2'],
    ['double-quoted assignment', 'token="abc123"', 'abc123'],
    ['quoted value with spaces', "db_password = 'two words here'", 'two words'],
    ['unterminated quoted value', 'api_key="opaque-unterminated', 'opaque-unterminated'],
    ['pass-word spelling', 'pass-word=opaque-hyphen-value', 'opaque-hyphen-value'],
    ['pwd spelling', 'SMTP_PWD: opaque-pwd-value', 'opaque-pwd-value'],
  ])('removes a %s', (_label, input, secret) => {
    const out = redactForMcp(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('<redacted');
  });

  it('redacts quoted assignments to exactly <redacted>', () => {
    expect(redactForMcp("password='hunter2' user=bob")).toBe('password=<redacted> user=bob');
    expect(redactForMcp('token="abc123" ok')).toBe('token=<redacted> ok');
  });

  it('redacts the entire value of Cookie / Set-Cookie headers', () => {
    expect(redactForMcp('Cookie: a=1; session=abc; theme=dark')).toBe('Cookie: <redacted>');
    expect(redactForMcp('Set-Cookie: sid=opaque-sid; Path=/; HttpOnly\nnext line')).toBe('Set-Cookie: <redacted>\nnext line');
    const out = redactForMcp('req headers: Cookie: a=1; session=abc; theme=dark');
    expect(out).not.toMatch(/a=1|abc|theme=dark/);
  });

  it('redacts a quoted value that starts with a known-format key and has trailing words', () => {
    // redactSecretsText turns the sk- key into a marker first; the rest of
    // the quoted value must still be consumed (Codex re-review, 2026-11-15).
    expect(redactForMcp("password='sk-AAAAAAAAAAAAAAAAAAAAAAAA trailing-secret-words'")).toBe('password=<redacted>');
    expect(redactForMcp('token="sk-AAAAAAAAAAAAAAAAAAAAAAAA more-secret-words"')).toBe('token=<redacted>');
  });

  it('leaves a quoted value that is exactly a redaction marker untouched', () => {
    expect(redactForMcp('{"password": "<redacted>"}')).toBe('{"password": "<redacted>"}');
  });

  it('an empty Cookie header does not consume the following line', () => {
    expect(redactForMcp('Cookie:\nGET /home 200 OK')).toBe('Cookie:<redacted>\nGET /home 200 OK');
    expect(redactForMcp('Set-Cookie: \nplain next line')).toBe('Set-Cookie: <redacted>\nplain next line');
  });

  it('leaves ordinary text alone', () => {
    const line = '[Shelly][MCPBridge] answered call c1 (tool=list_repos, ok=true)';
    expect(redactForMcp(line)).toBe(line);
  });

  it('get_settings: a secret embedded in an innocuously named URL setting is not returned', () => {
    const { settings, withheldKeys } = redactSettingsForMcp({ localLlmUrl: 'https://alice:plain-password@host.example/v1?token=opaque-token-value' });
    expect(withheldKeys).toEqual([]);
    expect(JSON.stringify(settings)).not.toMatch(/plain-password|opaque-token-value/);
    expect(String(settings.localLlmUrl)).toContain('host.example/v1');
  });
});

describe('read_logs', () => {
  it('returns the redacted [Shelly] lines debug-logger wrote, newest last', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    logInfo('Example', 'first line');
    logInfo('Example', 'leaked GEMINI_API_KEY=abcdefgh12345678 here');
    const result = await call('read_logs', { limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.data.source).toBe('app');
    expect(result.data.text).toContain('[Shelly][Example] first line');
    expect(result.data.text).not.toContain('abcdefgh12345678');
    expect(result.data.text.indexOf('first line')).toBeLessThan(result.data.text.indexOf('leaked'));
  });

  it('honours limit and the hard byte cap, whatever the caller asks for', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i} ${'x'.repeat(4000)}`);
    const few = capLogLines(lines, 3, READ_LOGS_MAX_BYTES);
    expect(few.returned).toBe(3);
    expect(few.text.startsWith('line-47 ')).toBe(true);
    expect(few.truncated).toBe(true);
    const capped = capLogLines(lines, 1000, 10_000);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(10_000);
    expect(capped.text.endsWith('x')).toBe(true);
    const huge = capLogLines(['y'.repeat(200_000)], 10, 1000);
    expect(Buffer.byteLength(huge.text)).toBe(1000);
  });

  it('clamps an oversized maxBytes to READ_LOGS_MAX_BYTES', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    for (let i = 0; i < 200; i++) logInfo('Bulk', `${i} ${'z'.repeat(1500)}`);
    const result = await call('read_logs', { limit: 1000, maxBytes: 10_000_000 });
    expect(Buffer.byteLength(result.data.text)).toBeLessThanOrEqual(READ_LOGS_MAX_BYTES);
    expect(result.data.truncated).toBe(true);
  });

  it('keeps the ring bounded', () => {
    for (let i = 0; i < DEBUG_LOG_CAPACITY + 50; i++) logInfo('Ring', `n${i}`);
    const entries = getDebugLogEntries();
    expect(entries).toHaveLength(DEBUG_LOG_CAPACITY);
    expect(entries[entries.length - 1].line).toContain(`n${DEBUG_LOG_CAPACITY + 49}`);
  });

  it('logcat source: runs own-process logcat for Shelly tags only and filters + redacts lines', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    mockExecCommand.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: '',
      stdout: [
        '--------- beginning of main',
        "11-15 10:00:00.000  1234  1250 I ReactNativeJS: '[Shelly][MCPBridge] answered call c1', ''",
        '11-15 10:00:00.100  1234  1250 I ReactNativeJS: some library chatter',
        '11-15 10:00:00.200  1234  1260 I MCPBridge: [shelly-mcp] listening on 0.0.0.0:8767',
        '11-15 10:00:00.300  1234  1260 I OtherLib: token=sk-ant-abcdefghijklmnopqrstuvwxyz0123',
        '11-15 10:00:00.400  1234  1260 W HomeInitializer: key gsk_abcdefghijklmnopqrstuvwxyz',
      ].join('\n'),
    }));
    const result = await call('read_logs', { source: 'logcat' });
    expect(result.ok).toBe(true);
    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toMatch(/^logcat -d -v threadtime -t \d+ -s /);
    expect(result.data.text).toContain('[Shelly][MCPBridge] answered call c1');
    expect(result.data.text).toContain('listening on 0.0.0.0:8767');
    expect(result.data.text).not.toContain('library chatter');
    expect(result.data.text).not.toContain('OtherLib');
    expect(result.data.text).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz');
    expect(result.data.lines).toBe(3);
  });

  it('logcat source: reports a clear error when logcat is not readable', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    mockExecCommand.mockImplementationOnce(async () => ({ exitCode: 1, stderr: 'permission denied', stdout: '' }));
    const result = await call('read_logs', { source: 'logcat' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('logcat is not readable');
  });

  it('refuses an unknown source', async () => {
    mockSettings.mcpDiagnosticsEnabled = true;
    const result = await call('read_logs', { source: '/etc/passwd' });
    expect(result.ok).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('filterLogcatLines drops non-Shelly ReactNativeJS lines (pure)', () => {
    expect(filterLogcatLines('11-15 10:00:00.000  1  2 I ReactNativeJS: hello')).toEqual([]);
  });
});

describe('device_status', () => {
  it('queue fallback: answers from a live native reading with capturedAt, ageMs 0, stale false — no toggle needed', async () => {
    const result = await call('device_status');
    expect(result.ok).toBe(true);
    expect(result.data.capturedAt).toBe('2026-11-15T10:00:00.000Z');
    expect(result.data.battery).toEqual({ level: 81, charging: true, plugged: 'usb', status: 'charging' });
    expect(result.data.thermal).toEqual({ status: 'none' });
    expect(result.data.ageMs).toBe(0);
    expect(result.data.stale).toBe(false);
  });

  it('reports a clear error when the native build has no reading', async () => {
    mockDeviceStatus.mockImplementationOnce(async () => { throw new Error('boom'); });
    const result = await call('device_status');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('device status');
  });

  it('deviceSectionFromNative keeps known sections, nulls bad ones, rejects a missing capturedAtMs', () => {
    expect(deviceSectionFromNative(null)).toBeNull();
    expect(deviceSectionFromNative({ battery: {} })).toBeNull();
    const s = deviceSectionFromNative({ capturedAtMs: 0, battery: 'x', thermal: null, memory: { a: 1 }, extra: { b: 2 } });
    expect(s).toEqual({ capturedAt: '1970-01-01T00:00:00.000Z', battery: null, thermal: null, memory: { a: 1 }, storage: null, app: null, uptime: null, bundle: expect.objectContaining({ schema: 1 }) });
  });

  it('deviceSectionFromNative embeds a validated bundle fingerprint (known keys only)', () => {
    const s = deviceSectionFromNative({ capturedAtMs: 0 });
    expect(Object.keys(s!.bundle!).sort()).toEqual(['gitSha', 'runId', 'runNumber', 'schema', 'source']);
    expect(bundleFingerprint({ schema: 1, source: 'ci', gitSha: 'abc', runId: 7, runNumber: 9, extra: 'x' })).toEqual({ schema: 1, source: 'ci', gitSha: 'abc', runId: 7, runNumber: 9 });
    expect(bundleFingerprint({ schema: {}, gitSha: ['x'], runId: NaN })).toEqual({ schema: null, source: null, gitSha: null, runId: null, runNumber: null });
    expect(bundleFingerprint('nope')).toBeNull();
  });

  it('the publisher puts a signed device section in the snapshot the server can answer from', async () => {
    const token = 'snap-token';
    startMCPSnapshotPublisher(token);
    const snapUri = `${QUEUE}/snapshot.json`;
    await waitFor(() => {
      const raw = mockFiles.get(snapUri);
      return !!raw && JSON.parse(JSON.parse(raw).body).device !== undefined;
    });
    const outer = JSON.parse(mockFiles.get(snapUri)!);
    expect(outer.mac).toBe(await signSnapshot(token, outer.body, nodeSha256));
    expect(outer.mac).toBe(nodeCrypto.createHmac('sha256', nodeCrypto.createHash('sha256').update(`shelly-mcp-snapshot:${token}`).digest()).update(outer.body).digest('hex'));
    const answer = mcp.deviceStatusFromSnapshot(JSON.parse(outer.body).device, Date.parse('2026-11-15T10:01:00.000Z'));
    expect(answer.ok).toBe(true);
    expect(answer.data.ageMs).toBe(60_000);
    expect(answer.data.app).toEqual({ versionName: '9.9.9', versionCode: 999 });
  });
});
