/**
 * MONITOR CLI tokens (DEFERRED.md P2「MONITOR の CLI トークン」): a completed
 * Codex CLI step showed "Codex CLI 100% 0 tok" because the driver never read
 * the Codex app-server token usage notifications.
 *
 *  - driver: thread/tokenUsage/updated (v2) and codex/event/token_count
 *    (legacy) are folded into the same `--usage-file` JSON Claude writes;
 *    a host E2E against a fake app-server proves the file is written;
 *  - .sh (AGENT_SCRIPT_VERSION 77): Codex driver calls pass --usage-file;
 *  - MONITOR: a step with no reported usage shows "—", not "0 tok".
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FAKE_CODEX_MCP_LIST, FAKE_CODEX_FEATURES_LIST } from './fixtures/fake-codex-mcp-list';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { driverEngineArgs } from '@/lib/agent-executor';
import { parseProgressJsonl } from '@/lib/agent-progress';
import { createLiveSource } from '@/lib/monitor-live';
import { formatAgentTokens, TOKENS_UNREPORTED } from '@/lib/monitor-source';

const root = path.resolve(__dirname, '..');
const driverPath = path.join(root, 'scripts/shelly-agent-driver.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const driver = require(driverPath);

const v2 = (total: object | null, last: object | null = null) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'th1',
    turnId: 't1',
    tokenUsage: { ...(total ? { total } : {}), ...(last ? { last } : {}), modelContextWindow: 272000 },
  },
});

describe('driver: Codex token usage notifications', () => {
  it('parses the v2 thread/tokenUsage/updated shape (camelCase)', () => {
    const u = driver.codexTokenUsageFromNotification(v2(
      { totalTokens: 1530, inputTokens: 1200, cachedInputTokens: 800, outputTokens: 330, reasoningOutputTokens: 120 },
      { totalTokens: 530, inputTokens: 400, cachedInputTokens: 0, outputTokens: 130, reasoningOutputTokens: 20 },
    ));
    // input already includes the cached part, output already includes reasoning
    expect(u).toEqual({ total: { inputTokens: 1200, outputTokens: 330 }, last: { inputTokens: 400, outputTokens: 130 } });
  });

  it('parses the legacy codex/event/token_count shape (snake_case)', () => {
    const u = driver.codexTokenUsageFromNotification({
      method: 'codex/event/token_count',
      params: { msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 7 }, last_token_usage: { input_tokens: 50, output_tokens: 7 } } } },
    });
    expect(u).toEqual({ total: { inputTokens: 50, outputTokens: 7 }, last: { inputTokens: 50, outputTokens: 7 } });
  });

  it('ignores other notifications, an empty token_count (info:null), and junk numbers', () => {
    expect(driver.codexTokenUsageFromNotification({ method: 'item/completed', params: { item: {} } })).toBeNull();
    expect(driver.codexTokenUsageFromNotification({ method: 'codex/event/token_count', params: { msg: { type: 'token_count', info: null } } })).toBeNull();
    expect(driver.codexTokenUsageFromNotification(v2({ inputTokens: -1, outputTokens: 'x' }))).toBeNull();
    expect(driver.codexTokenUsageFromNotification({ id: 3, result: {} })).toBeNull();
  });

  it('the accumulator keeps the latest cumulative total, and sums `last` only without a total', () => {
    const acc = driver.createCodexUsageAccumulator();
    expect(acc.value()).toBeNull();
    expect(acc.observe({ method: 'turn/started', params: {} })).toBe(false);
    expect(acc.observe(v2({ inputTokens: 100, outputTokens: 10 }, { inputTokens: 100, outputTokens: 10 }))).toBe(true);
    expect(acc.observe(v2({ inputTokens: 250, outputTokens: 30 }, { inputTokens: 150, outputTokens: 20 }))).toBe(true);
    expect(acc.value()).toEqual({ inputTokens: 250, outputTokens: 30 });

    const lastOnly = driver.createCodexUsageAccumulator();
    lastOnly.observe(v2(null, { inputTokens: 100, outputTokens: 10 }));
    lastOnly.observe(v2(null, { inputTokens: 150, outputTokens: 20 }));
    expect(lastOnly.value()).toEqual({ inputTokens: 250, outputTokens: 30 });
  });

  it('writeUsageFile writes the same flat JSON the .sh accepts, and nothing for no usage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
    try {
      const file = path.join(dir, 'r.usage.json');
      expect(driver.writeUsageFile(file, null)).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
      expect(driver.writeUsageFile(file, { inputTokens: 250, outputTokens: 30 })).toBe(true);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toBe('{"inputTokens":250,"outputTokens":30}');
      // CLAUDE_USAGE_FIELDS_SNIPPET's grep, verbatim
      expect(raw).toMatch(/^\{"(inputTokens|outputTokens|usd)":[0-9][0-9.eE+-]{0,24}(,"(inputTokens|outputTokens|usd)":[0-9][0-9.eE+-]{0,24}){0,2}\}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A fake `codex app-server`: the driver's host spawn is `<codex-bin> app-server
// --listen stdio://`, so --codex-bin = node and a file named `app-server` in
// --cwd makes node run this script (works on every host OS).
const FAKE_APP_SERVER = `
const readline = require('readline');
const mode = process.env.FAKE_CODEX_USAGE_MODE || 'v2';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { return; }
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: 'th1' } } });
  else if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } });
    out({ method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: { type: 'agentMessage', id: 'i1', text: 'FAKE ANSWER' } } });
    if (mode === 'v2') {
      out({ method: 'thread/tokenUsage/updated', params: { threadId: 'th1', turnId: 't1', tokenUsage: { total: { totalTokens: 900, inputTokens: 800, cachedInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 40 }, last: { totalTokens: 900, inputTokens: 800, cachedInputTokens: 300, outputTokens: 100, reasoningOutputTokens: 40 }, modelContextWindow: 272000 } } });
      out({ method: 'thread/tokenUsage/updated', params: { threadId: 'th1', turnId: 't1', tokenUsage: { total: { totalTokens: 1530, inputTokens: 1200, cachedInputTokens: 800, outputTokens: 330, reasoningOutputTokens: 120 }, last: { totalTokens: 630, inputTokens: 400, cachedInputTokens: 500, outputTokens: 230, reasoningOutputTokens: 80 }, modelContextWindow: 272000 } } });
    }
    out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 't1', status: 'completed' } } });
  }
});
`;

describe('driver E2E: a Codex turn writes the usage file', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-e2e-'));
    fs.writeFileSync(path.join(dir, 'app-server'), FAKE_APP_SERVER);
    fs.writeFileSync(path.join(dir, 'mcp'), FAKE_CODEX_MCP_LIST);
    fs.writeFileSync(path.join(dir, 'features'), FAKE_CODEX_FEATURES_LIST);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (mode: string) => {
    const usageFile = path.join(dir, `${mode}.usage.json`);
    const answerFile = path.join(dir, `${mode}.answer`);
    fs.writeFileSync(usageFile, '{"inputTokens":1}'); // stale: must be removed first
    const r = childProcess.spawnSync(process.execPath, [
      driverPath,
      '--cwd', dir,
      '--prompt', 'say hi',
      '--codex-bin', process.execPath,
      '--allow-unpinned-verifier-key',
      '--audit-log', path.join(dir, `${mode}.audit.jsonl`),
      '--answer-file', answerFile,
      '--usage-file', usageFile,
      '--timeout-ms', '15000',
    ], { cwd: dir, env: { ...process.env, FAKE_CODEX_USAGE_MODE: mode }, encoding: 'utf8', timeout: 30000 });
    return { r, usageFile, answerFile };
  };

  it('records the latest cumulative total from thread/tokenUsage/updated', () => {
    const { r, usageFile, answerFile } = run('v2');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(answerFile, 'utf8').trim()).toBe('FAKE ANSWER');
    expect(JSON.parse(fs.readFileSync(usageFile, 'utf8'))).toEqual({ inputTokens: 1200, outputTokens: 330 });
  }, 40000);

  it('writes no usage file when the app-server reported none (MONITOR then shows —)', () => {
    const { r, usageFile } = run('none');
    expect(r.status).toBe(0);
    expect(fs.existsSync(usageFile)).toBe(false);
  }, 40000);
});

describe('.sh: Codex driver calls pass the usage sidecar (v77)', () => {
  it('codex: --usage-file without --engine; claude: --engine claude then --usage-file', () => {
    expect(driverEngineArgs('codex', '  ')).toBe('  --usage-file "$RESULT_FILE.usage.json" \\\n');
    expect(driverEngineArgs(undefined, '  ')).toBe('  --usage-file "$RESULT_FILE.usage.json" \\\n');
    expect(driverEngineArgs('claude', '  ')).toBe('  --engine claude \\\n  --usage-file "$RESULT_FILE.usage.json" \\\n');
  });
});

describe('MONITOR: unreported usage is "—", not "0 tok"', () => {
  const T0 = Date.parse('2026-11-01T07:00:00.000Z');
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const runFrom = (events: Record<string, unknown>[]) => {
    const text = events
      .map((e, i) => JSON.stringify({ v: 1, runId: 'r1', agentId: 'agent-1', seq: i + 1, ts: at((e.sec as number) ?? i), ...e }))
      .join('\n');
    const run = parseProgressJsonl(text);
    if (!run) throw new Error('no run');
    return run;
  };
  const codexStep = (extra: Record<string, unknown>[]) => runFrom([
    { kind: 'run_start', mode: 'SINGLE', stepCount: 1, sec: 0 },
    { kind: 'branch_state', stepIndex: 0, state: 'RUNNING', sec: 1 },
    { kind: 'tool', stepIndex: 0, tool: 'Codex CLI', provider: { kind: 'CLI', name: 'cli:codex' }, sec: 1 },
    ...extra,
    { kind: 'branch_state', stepIndex: 0, state: 'DONE', sec: 5 },
    { kind: 'run_end', status: 'success', sec: 5 },
  ]);

  it('a CLI step that reported no usage is tokensReported:false and formats as —', () => {
    const snap = createLiveSource(codexStep([])).snapshot(T0 + 6000, []);
    expect(snap.agents.s0).toMatchObject({ state: 'DONE', tokens: 0, tokensReported: false });
    expect(formatAgentTokens(snap.agents.s0)).toBe(TOKENS_UNREPORTED);
    expect(TOKENS_UNREPORTED).toBe('—');
  });

  it('a step whose usage was reported still formats as tokens', () => {
    const snap = createLiveSource(codexStep([
      { kind: 'usage', stepIndex: 0, usage: { inputTokens: 1200, outputTokens: 330 }, sec: 4 },
    ])).snapshot(T0 + 6000, []);
    expect(snap.agents.s0).toMatchObject({ tokens: 1530, tokensReported: true });
    expect(formatAgentTokens(snap.agents.s0)).toBe('1.5k tok');
    expect(formatAgentTokens({ tokens: 0, tokensReported: true })).toBe('0 tok');
    // DEMO snapshots leave the flag out: always a count.
    expect(formatAgentTokens({ tokens: 42 })).toBe('42 tok');
  });
});
