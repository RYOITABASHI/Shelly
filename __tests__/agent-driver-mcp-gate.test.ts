/**
 * Codex worker MCP / ChatGPT-app lockout (DEFERRED.md P1「Codex ワーカーの
 * ChatGPT アプリ（MCP）ツール呼び出しがゲートを通るか未確認」).
 *
 * MCP and app tool calls run inside Codex with no approval request the driver
 * could gate, so:
 *  - the app-server is started with apps / plugins off and every configured
 *    MCP server disabled by name (names from a `codex mcp list --json`
 *    preflight; a second listing must show all of them disabled, or Codex is
 *    never started);
 *  - any mcpToolCall item, MCP progress, elicitation or other MCP server
 *    request aborts the turn and fails the run with an audit record that
 *    carries names only, never arguments.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FAKE_CODEX_MCP_LIST } from './fixtures/fake-codex-mcp-list';

const root = path.resolve(__dirname, '..');
const driverPath = path.join(root, 'scripts/shelly-agent-driver.js');
const gateScript = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js');
const driver = require('../scripts/shelly-agent-driver.js');

describe('Codex worker spawn args: MCP servers and apps are disabled', () => {
  it('passes the feature / app / per-server overrides to app-server (host spawn)', () => {
    const spec = driver.codexAppServerSpawnSpec({ codexBin: 'codex' }, ['mercari', 'shelly-phone']);
    expect(spec.args[0]).toBe('app-server');
    expect(spec.args.slice(-2)).toEqual(['--listen', 'stdio://']);
    const joined = spec.args.join(' ');
    for (const feature of ['apps', 'plugins', 'enable_mcp_apps', 'tool_suggest', 'computer_use', 'browser_use']) {
      expect(joined).toContain(`-c features.${feature}=false`);
    }
    expect(joined).toContain('-c apps._default.enabled=false');
    expect(joined).toContain('-c mcp_servers.mercari.enabled=false');
    expect(joined).toContain('-c mcp_servers.shelly-phone.enabled=false');
    // never `--disable <feature>`: an unknown feature name is a hard error in Codex
    expect(spec.args).not.toContain('--disable');
  });

  it('keeps the feature / app overrides with no configured servers', () => {
    const spec = driver.codexAppServerSpawnSpec({ codexBin: 'codex' });
    expect(spec.args.join(' ')).toContain('-c features.apps=false');
    expect(spec.args.join(' ')).not.toContain('mcp_servers.');
  });

  it('refuses a server name that cannot be a plain dotted -c key', () => {
    for (const bad of ['a.b', 'a b', 'x"y', '', 'a=b']) {
      expect(() => driver.codexMcpDisableArgs([bad])).toThrow(/unsafe MCP server name/);
    }
  });
});

describe('codexMcpPreflight', () => {
  const config = { codexBin: 'codex', cwd: os.tmpdir() };
  // Simulates codex: a server is enabled unless its disable override is present.
  const runnerFor = (names: string[], opts: { ignoreDisable?: boolean } = {}) => {
    const calls: string[][] = [];
    const runner = (_spec: unknown, args: string[]) => {
      calls.push(args);
      return JSON.stringify(names.map((name) => ({
        name,
        enabled: opts.ignoreDisable || !args.includes(`mcp_servers.${name}.enabled=false`),
      })));
    };
    return { runner, calls };
  };

  it('no configured server: one listing, ok', () => {
    const { runner, calls } = runnerFor([]);
    expect(driver.codexMcpPreflight(config, runner)).toEqual({ ok: true, names: [], configuredCount: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['mcp', 'list']);
    expect(calls[0]).toContain('features.apps=false');
    expect(calls[0][calls[0].length - 1]).toBe('--json');
  });

  it('configured servers are disabled by name and re-listed', () => {
    const { runner, calls } = runnerFor(['shelly-phone', 'mercari']);
    const r = driver.codexMcpPreflight(config, runner);
    expect(r).toEqual({ ok: true, names: ['mercari', 'shelly-phone'], configuredCount: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('mcp_servers.mercari.enabled=false');
    expect(calls[1]).toContain('mcp_servers.shelly-phone.enabled=false');
  });

  it('fails closed when a server stays enabled, the listing fails, or it is not JSON / unsafe', () => {
    const stuck = runnerFor(['mercari'], { ignoreDisable: true });
    const r = driver.codexMcpPreflight(config, stuck.runner);
    expect(r.ok).toBe(false);
    expect(r.stillEnabled).toEqual(['mercari']);

    const throwing = driver.codexMcpPreflight(config, () => { throw new Error('ENOENT'); });
    expect(throwing.ok).toBe(false);
    expect(throwing.reason).toMatch(/mcp list failed/);

    expect(driver.codexMcpPreflight(config, () => 'not json').ok).toBe(false);
    expect(driver.codexMcpPreflight(config, () => '{"name":"x"}').ok).toBe(false);
    expect(driver.codexMcpPreflight(config, () => '[{"name":"a.b","enabled":true}]').ok).toBe(false);
    expect(driver.codexMcpPreflight(config, () => '[{"enabled":true}]').ok).toBe(false);
  });

  it('a server that only appears in the second listing also fails closed', () => {
    let n = 0;
    const r = driver.codexMcpPreflight(config, () => (n++ === 0
      ? '[{"name":"a","enabled":true}]'
      : '[{"name":"a","enabled":false},{"name":"late","enabled":false}]'));
    expect(r.ok).toBe(false);
    expect(r.stillEnabled).toEqual(['late']);
  });
});

// Scripted fake `codex app-server` (host spawn: node + file `app-server` in the
// cwd). Records its argv; after turn/start plays FAKE_SCRIPT, waiting for the
// driver's answer to each server request (recorded immediately).
const FAKE_APP_SERVER = `
const fs = require('fs');
const readline = require('readline');
fs.writeFileSync(process.env.FAKE_ARGV_RECORD, JSON.stringify(process.argv.slice(2)));
const script = JSON.parse(process.env.FAKE_SCRIPT || '[]');
const record = process.env.FAKE_RECORD;
const responses = {};
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let waitingFor = null;
let step = 0;
const play = () => {
  while (step < script.length) {
    const m = script[step++];
    out(m);
    if (m.id !== undefined && m.method) { waitingFor = String(m.id); return; }
  }
  out({ method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: { type: 'agentMessage', id: 'msg', text: 'DONE' } } });
  out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 't1', status: 'completed' } } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { return; }
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: 'th1' } } });
  else if (m.method === 'turn/start') { out({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } }); play(); }
  else if (waitingFor !== null && String(m.id) === waitingFor) {
    responses[waitingFor] = m.result !== undefined ? m.result : { error: m.error };
    fs.writeFileSync(record, JSON.stringify(responses));
    waitingFor = null;
    play();
  }
});
`;

describe('driver E2E: MCP / app activity is blocked', () => {
  type Msg = Record<string, unknown>;
  const SECRET_ARG = 'SECRET-ARGUMENT-VALUE';

  function run(script: Msg[], env: Record<string, string> = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-'));
    const ws = path.join(home, 'demo');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'app-server'), FAKE_APP_SERVER);
    fs.writeFileSync(path.join(ws, 'mcp'), FAKE_CODEX_MCP_LIST);
    const rec = path.join(home, 'rec.json');
    const argvRec = path.join(home, 'argv.json');
    const auditLog = path.join(home, 'audit.jsonl');
    const answerFile = path.join(home, 'answer.md');
    const r = childProcess.spawnSync(process.execPath, [
      driverPath,
      '--cwd', ws,
      '--prompt', 'look up prices',
      '--codex-bin', process.execPath,
      '--gate-script', gateScript,
      '--policy-json', JSON.stringify({ unattended: true }),
      '--allow-unpinned-verifier-key',
      '--escalation-dir', path.join(home, 'esc'),
      '--escalation-reply-dir', path.join(home, 'esc-reply'),
      '--audit-log', auditLog,
      '--answer-file', answerFile,
      '--timeout-ms', '30000',
    ], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 45000,
      env: {
        ...process.env,
        HOME: home,
        FAKE_SCRIPT: JSON.stringify(script),
        FAKE_RECORD: rec,
        FAKE_ARGV_RECORD: argvRec,
        ...env,
      },
    });
    const read = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
    const result = {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      responses: read(rec),
      appServerArgv: read(argvRec) as string[] | null,
      answerWritten: fs.existsSync(answerFile),
      audit: fs.existsSync(auditLog) ? fs.readFileSync(auditLog, 'utf8') : '',
    };
    fs.rmSync(home, { recursive: true, force: true });
    return result;
  }

  const auditKinds = (audit: string) => audit.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);

  it('configured MCP servers are disabled by name on the app-server command line; a plain turn still succeeds', () => {
    const r = run([], { FAKE_MCP_SERVERS: 'mercari,shelly-phone' });
    expect(r.status).toBe(0);
    expect(r.appServerArgv).toEqual(expect.arrayContaining([
      'features.apps=false', 'features.plugins=false', 'apps._default.enabled=false',
      'mcp_servers.mercari.enabled=false', 'mcp_servers.shelly-phone.enabled=false',
    ]));
    const start = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'driver_start');
    expect(start.codexMcp).toEqual(expect.objectContaining({ ok: true, disabledServers: ['mercari', 'shelly-phone'] }));
    expect(r.out).not.toContain('do-not-log');
  }, 60_000);

  it('preflight failure (a server stays enabled) never starts Codex and fails the run', () => {
    const r = run([], { FAKE_MCP_SERVERS: 'mercari', FAKE_MCP_IGNORE_DISABLE: '1' });
    expect(r.status).toBe(1);
    expect(r.appServerArgv).toBeNull();
    expect(auditKinds(r.audit)).toEqual(expect.arrayContaining(['driver_start', 'codex_mcp_preflight_failed', 'driver_finish']));
    expect(r.out).not.toContain('do-not-log');

    const failing = run([], { FAKE_MCP_LIST_FAIL: '1' });
    expect(failing.status).toBe(1);
    expect(failing.appServerArgv).toBeNull();
    expect(failing.audit).toContain('codex_mcp_preflight_failed');
  }, 90_000);

  it('an mcpToolCall item aborts the turn, fails the run, and audits names only', () => {
    const r = run([
      {
        method: 'item/started',
        params: {
          threadId: 'th1',
          turnId: 't1',
          item: { type: 'mcpToolCall', id: 'mcp-1', server: 'codex_apps', tool: 'mercari_search', status: 'inProgress', arguments: { q: SECRET_ARG } },
        },
      },
    ]);
    expect(r.status).toBe(1);
    const blocked = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'mcp_tool_call_blocked');
    expect(blocked).toEqual(expect.objectContaining({ server: 'codex_apps', tool: 'mercari_search', itemId: 'mcp-1', phase: 'started' }));
    expect(r.out).toMatch(/C->S \{"id":\d+,"method":"turn\/interrupt","params":\{"threadId":"th1","turnId":"t1"\}\}/);
    expect(r.audit).not.toContain(SECRET_ARG);
    expect(r.answerWritten).toBe(false);
    expect(auditKinds(r.audit)).not.toContain('turn_completed');
  }, 60_000);

  it('an mcpToolCall seen only on item/completed is also blocked', () => {
    const r = run([
      { method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: { type: 'mcpToolCall', id: 'mcp-2', server: 's', tool: 't', status: 'completed', arguments: { q: SECRET_ARG } } } },
    ]);
    expect(r.status).toBe(1);
    expect(r.audit).toContain('"phase":"completed"');
    expect(r.audit).not.toContain(SECRET_ARG);
  }, 60_000);

  it('an MCP elicitation request is declined (never accepted) and fails the run', () => {
    const r = run([
      { id: 'el-1', method: 'mcpServer/elicitation/request', params: { threadId: 'th1', turnId: 't1', serverName: 'mercari', mode: 'form', message: 'Confirm purchase?', requestedSchema: {} } },
    ]);
    // The driver's own wire log (the fake may be killed before it records).
    expect(r.out).toContain('C->S {"id":"el-1","result":{"action":"decline","content":null}}');
    expect(r.out).not.toMatch(/"action":"accept"/);
    expect(r.status).toBe(1);
    expect(r.audit).toContain('mcp_elicitation_blocked');
    expect(r.audit).toContain('"server":"mercari"');
  }, 60_000);

  it('any other MCP server request is refused with an error and fails the run', () => {
    const r = run([
      { id: 'm-1', method: 'mcpServer/toolApproval/request', params: { threadId: 'th1', turnId: 't1', serverName: 'x', arguments: { q: SECRET_ARG } } },
    ]);
    expect(r.out).toContain('C->S {"id":"m-1","error":');
    expect(r.status).toBe(1);
    expect(r.audit).toContain('mcp_request_blocked');
    expect(r.audit).not.toContain(SECRET_ARG);
  }, 60_000);
});
