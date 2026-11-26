/**
 * "Web search on notification-triggered runs" per article pipeline (search
 * parity, executor v68). The TS wrapper runs here with a mocked native module;
 * the native half (Kotlin does not run under jest) is pinned by reading its
 * source, like closepaw-draft-preapproval.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockNative: {
  getWebSearchOptIns?: jest.Mock;
  setWebSearchOptIn?: jest.Mock;
} = {};
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: mockNative }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import {
  canToggleWebSearchOptIn,
  getWebSearchOptIns,
  parseWebSearchOptInList,
  parseWebSearchOptInResult,
  setWebSearchOptIn,
  webSearchOptInLabel,
  type WebSearchOptInPipeline,
} from '@/lib/web-search-opt-in';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function pipeline(over: Partial<WebSearchOptInPipeline> = {}): WebSearchOptInPipeline {
  return {
    agentId: 'agent-1',
    name: 'Morning article',
    pipelineId: 'morning',
    definitionSha256: SHA_A,
    webSearchStep: true,
    state: 'off',
    enabledAt: null,
    missing: false,
    ...over,
  };
}

beforeEach(() => {
  delete mockNative.getWebSearchOptIns;
  delete mockNative.setWebSearchOptIn;
});

describe('parseWebSearchOptInList', () => {
  it('reads a well-formed list', () => {
    const raw = JSON.stringify({
      ok: true,
      code: 'ok',
      pipelines: [
        { agentId: 'agent-1', name: 'A', pipelineId: 'a', definitionSha256: SHA_A, webSearchStep: true, state: 'on', enabledAt: 5, missing: false },
        { agentId: 'agent-2', name: null, pipelineId: null, definitionSha256: SHA_B, webSearchStep: false, state: 'off', enabledAt: null, missing: false },
        { agentId: 'agent-3', name: null, pipelineId: null, definitionSha256: null, webSearchStep: false, state: 'lapsed', enabledAt: 9, missing: true },
      ],
    });
    const list = parseWebSearchOptInList(raw);
    expect(list.ok).toBe(true);
    expect(list.pipelines.map((p) => [p.agentId, p.state, p.missing])).toEqual([
      ['agent-1', 'on', false],
      ['agent-2', 'off', false],
      ['agent-3', 'lapsed', true],
    ]);
    expect(list.pipelines[0].enabledAt).toBe(5);
  });

  it('drops malformed entries and duplicates', () => {
    const list = parseWebSearchOptInList({
      ok: true,
      code: 'ok',
      pipelines: [
        { agentId: '../x', definitionSha256: SHA_A, webSearchStep: true, state: 'off' },
        { agentId: 'agent-1', definitionSha256: 'ABC', webSearchStep: true, state: 'off' },
        { agentId: 'agent-1', definitionSha256: SHA_A, webSearchStep: 'yes', state: 'off' },
        { agentId: 'agent-1', definitionSha256: SHA_A, webSearchStep: true, state: 'maybe' },
        { agentId: 'agent-1', definitionSha256: SHA_A, webSearchStep: true, state: 'off', pipelineId: 'Bad Id' },
        { agentId: 'agent-1', definitionSha256: SHA_B, webSearchStep: true, state: 'on' },
        null,
      ],
    });
    expect(list.pipelines).toHaveLength(1);
    expect(list.pipelines[0].pipelineId).toBeNull();
    expect(list.pipelines[0].definitionSha256).toBe(SHA_A);
  });

  it('never reports a missing pipeline as on', () => {
    const list = parseWebSearchOptInList({
      ok: true,
      pipelines: [{ agentId: 'agent-9', definitionSha256: null, webSearchStep: true, state: 'on', missing: true }],
    });
    expect(list.pipelines[0]).toMatchObject({ state: 'lapsed', webSearchStep: false, missing: true });
  });

  it('passes the error code through and is not ok on garbage', () => {
    expect(parseWebSearchOptInList('{"ok":false,"code":"stale-executor","pipelines":[]}')).toEqual({
      ok: false,
      code: 'stale-executor',
      pipelines: [],
    });
    expect(parseWebSearchOptInList('not json').ok).toBe(false);
    expect(parseWebSearchOptInList('[]').ok).toBe(false);
  });
});

describe('parseWebSearchOptInResult', () => {
  it('reads ok and code', () => {
    expect(parseWebSearchOptInResult('{"ok":true,"code":"on"}')).toEqual({ ok: true, code: 'on' });
    expect(parseWebSearchOptInResult('{"ok":false,"code":"changed"}')).toEqual({ ok: false, code: 'changed' });
    expect(parseWebSearchOptInResult('{"ok":"true","code":"on"}').ok).toBe(false);
    expect(parseWebSearchOptInResult('nope')).toEqual({ ok: false, code: 'failed' });
  });
});

describe('labels and toggles', () => {
  it('labels by name, then pipeline id, then agent id', () => {
    expect(webSearchOptInLabel(pipeline())).toBe('Morning article');
    expect(webSearchOptInLabel(pipeline({ name: null }))).toBe('morning');
    expect(webSearchOptInLabel(pipeline({ name: null, pipelineId: null }))).toBe('agent-1');
  });

  it('only a listed web-search pipeline can be turned on; on / lapsed can always go off', () => {
    expect(canToggleWebSearchOptIn(pipeline())).toBe(true);
    expect(canToggleWebSearchOptIn(pipeline({ webSearchStep: false }))).toBe(false);
    expect(canToggleWebSearchOptIn(pipeline({ missing: true, definitionSha256: null, webSearchStep: false }))).toBe(false);
    expect(canToggleWebSearchOptIn(pipeline({ state: 'lapsed', missing: true, definitionSha256: null, webSearchStep: false }))).toBe(true);
    expect(canToggleWebSearchOptIn(pipeline({ state: 'on' }))).toBe(true);
  });
});

describe('native calls', () => {
  it('is unavailable without the native functions', async () => {
    expect(await getWebSearchOptIns()).toEqual({ ok: false, code: 'unavailable', pipelines: [] });
    expect(await setWebSearchOptIn(pipeline(), true)).toEqual({ ok: false, code: 'unavailable' });
  });

  it('ON passes the listed hash for native to check; OFF passes none', async () => {
    mockNative.setWebSearchOptIn = jest.fn().mockResolvedValue('{"ok":true,"code":"on"}');
    expect(await setWebSearchOptIn(pipeline(), true)).toEqual({ ok: true, code: 'on' });
    expect(mockNative.setWebSearchOptIn).toHaveBeenLastCalledWith('agent-1', true, SHA_A);
    mockNative.setWebSearchOptIn.mockResolvedValue('{"ok":true,"code":"off"}');
    expect(await setWebSearchOptIn(pipeline({ state: 'on' }), false)).toEqual({ ok: true, code: 'off' });
    expect(mockNative.setWebSearchOptIn).toHaveBeenLastCalledWith('agent-1', false, null);
  });

  it('refuses ON for a pipeline without a web-search step without calling native', async () => {
    mockNative.setWebSearchOptIn = jest.fn();
    expect(await setWebSearchOptIn(pipeline({ webSearchStep: false }), true)).toEqual({ ok: false, code: 'no-web-search' });
    expect(await setWebSearchOptIn(pipeline({ missing: true, definitionSha256: null }), true)).toEqual({ ok: false, code: 'no-web-search' });
    expect(mockNative.setWebSearchOptIn).not.toHaveBeenCalled();
  });

  it('a native throw reads as failed', async () => {
    mockNative.getWebSearchOptIns = jest.fn().mockRejectedValue(new Error('boom'));
    mockNative.setWebSearchOptIn = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await getWebSearchOptIns()).toEqual({ ok: false, code: 'failed', pipelines: [] });
    expect(await setWebSearchOptIn(pipeline(), true)).toEqual({ ok: false, code: 'failed' });
  });
});

describe('native source contract', () => {
  const dir = path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  const store = read('WebSearchOptInStore.kt');
  const runtime = read('AgentRuntime.kt');
  const module = read('TerminalEmulatorModule.kt');

  it('exports the hash only on a tainted, non-ingress PlanSpec launch, readonly', () => {
    expect(store).toContain('if (!tainted || ingressReason != null || !isValidSha256(storedSha256)) return ""');
    expect(store).toContain('" && export $ENV_NAME=$storedSha256 && readonly $ENV_NAME"');
    expect(store).toContain('const val ENV_NAME = "SHELLY_WEB_SEARCH_OPT_IN_SHA256"');
    // One launch site: runPlanAgent (the legacy .sh chain does not get it).
    expect(runtime.split('append(webSearchOptInExports(').length - 1).toBe(1);
    const planAgent = runtime.slice(runtime.indexOf('private fun runPlanAgent('));
    expect(planAgent).toContain('append(webSearchOptInExports(context, agentId, tainted, ingressReason))');
    expect(runtime).not.toContain('not exported by native yet');
  });

  it('stores the hash native computed, sealed with a fresh Keystore key per write', () => {
    expect(store).toContain('enable(context, agentId, c.definitionSha256)');
    expect(store).toContain('if (expectedSha256 != null && expectedSha256 != c.definitionSha256) return result(false, "changed")');
    expect(store).toContain('if (!c.webSearchStep) return result(false, "no-web-search")');
    expect(store).toContain('val key = newKey()');
    expect(store).toContain('MessageDigest.isEqual(');
    expect(runtime).toContain('" --web-search-opt-in-candidates"');
    expect(runtime).toContain('readExecutorScriptVersion(executor) != CURRENT_EXECUTOR_VERSION');
  });

  it('audits every toggle into the executor audit file, without following links', () => {
    expect(store).toContain('private const val AUDIT_FILE = "plan-executor-audit.jsonl"');
    expect(store).toContain('const val AUDIT_KIND = "web_search_opt_in"');
    expect(store).toContain('out.put("source", "settings")');
    expect(store).toContain('OsConstants.O_NOFOLLOW');
    expect(store).toContain('audit(context, "enabled", agentId, c.definitionSha256)');
    expect(store).toContain('audit(context, "disabled", agentId, removed)');
  });

  it('is reachable only through the two Settings module functions, off the main thread', () => {
    expect(module).toContain('AsyncFunction("getWebSearchOptIns") Coroutine');
    expect(module).toContain('AsyncFunction("setWebSearchOptIn") Coroutine');
    expect(module.split('WebSearchOptInStore.setFromSettings(').length - 1).toBe(1);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.kt') || name === 'WebSearchOptInStore.kt' || name === 'TerminalEmulatorModule.kt' || name === 'AgentRuntime.kt') continue;
      expect([name, read(name).includes('WebSearchOptInStore')]).toEqual([name, false]);
    }
    const mcpServer = path.join(__dirname, '../scripts/shelly-mcp-server.js');
    if (fs.existsSync(mcpServer)) expect(fs.readFileSync(mcpServer, 'utf8')).not.toMatch(/setWebSearchOptIn|WEB_SEARCH_OPT_IN_SHA256/);
  });
});
