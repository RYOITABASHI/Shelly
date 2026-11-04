/**
 * Codex worker MCP / ChatGPT-app lockout (DEFERRED.md P1「Codex ワーカーの
 * ChatGPT アプリ（MCP）ツール呼び出しがゲートを通るか未確認」).
 *
 * MCP and app tool calls run inside Codex with no approval request the driver
 * could gate, so:
 *  - prevention: the app-server and its preflight run with a fresh, per-run
 *    CODEX_HOME (generated config.toml without MCP servers / profiles / trust
 *    / hooks / notify, auth.json symlinked to the real one), removed after the
 *    run; no isolated home → Codex never starts;
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

describe('isolated CODEX_HOME for the Codex worker', () => {
  const mk = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-iso-'));
    const real = path.join(base, 'real');
    const parent = path.join(base, 'tmp');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'auth.json'), '{"t":1}');
    fs.writeFileSync(path.join(real, 'config.toml'), '[mcp_servers.x]\ncommand="x"\n');
    return { base, real, parent, env: { HOME: base, CODEX_HOME: real, TMPDIR: parent } };
  };
  const prefixed = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith(driver.CODEX_ISOLATED_HOME_PREFIX));

  it('the generated config.toml has no MCP servers, profiles, project trust, hooks or notify', () => {
    const toml: string = driver.codexWorkerConfigToml();
    // only comment lines may mention the excluded tables
    const body = toml.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    for (const banned of ['mcp_servers', '[profiles', '[projects', 'notify', 'hooks.json', 'trust_level', 'profile =']) {
      expect(body).not.toContain(banned);
    }
    expect(body).toContain('[features]');
    for (const f of ['apps', 'plugins', 'hooks', 'codex_hooks']) expect(body).toMatch(new RegExp(`^${f} = false$`, 'm'));
    expect(body).toContain('[apps._default]\nenabled = false');
    expect(body).toContain('check_for_update_on_startup = false');
  });

  it('creates a 0700 home with the generated config and an auth.json symlink to the real one; removal keeps the real file', () => {
    const t = mk();
    const r = driver.createCodexIsolatedHome(t.env);
    expect(r.ok).toBe(true);
    expect(path.dirname(r.dir)).toBe(t.parent);
    expect(r.dir).not.toBe(t.real);
    expect(fs.readdirSync(r.dir).sort()).toEqual(['auth.json', 'config.toml']);
    expect(fs.readFileSync(path.join(r.dir, 'config.toml'), 'utf8')).toBe(driver.codexWorkerConfigToml());
    const link = path.join(r.dir, 'auth.json');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(link), fs.readlinkSync(link))).toBe(path.join(t.real, 'auth.json'));
    if (process.platform !== 'win32') expect(fs.statSync(r.dir).mode & 0o777).toBe(0o700);
    driver.removeCodexIsolatedHome(r.dir);
    expect(fs.existsSync(r.dir)).toBe(false);
    expect(fs.readFileSync(path.join(t.real, 'auth.json'), 'utf8')).toBe('{"t":1}');
    fs.rmSync(t.base, { recursive: true, force: true });
  });

  it('defaults the real home to ~/.codex when CODEX_HOME is unset', () => {
    expect(driver.realCodexHome({ HOME: '/h' })).toBe(path.join('/h', '.codex'));
  });

  it('fails closed (and leaves nothing behind) when the auth.json symlink cannot be made', () => {
    const t = mk();
    const failing = { ...fs, symlinkSync: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); } };
    const r = driver.createCodexIsolatedHome(t.env, failing);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/auth\.json symlink failed: EPERM/);
    expect(prefixed(t.parent)).toEqual([]);
    fs.rmSync(t.base, { recursive: true, force: true });
  });

  it('sweeps isolated homes left by a killed driver more than a day ago, keeps fresh ones', () => {
    const t = mk();
    fs.mkdirSync(t.parent);
    const old = path.join(t.parent, `${driver.CODEX_ISOLATED_HOME_PREFIX}old`);
    const fresh = path.join(t.parent, `${driver.CODEX_ISOLATED_HOME_PREFIX}fresh`);
    fs.mkdirSync(old);
    fs.mkdirSync(fresh);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    const r = driver.createCodexIsolatedHome(t.env);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(t.base, { recursive: true, force: true });
  });

  describe('carried model settings', () => {
    const bodyOf = (toml: string) => toml.split('\n').filter((l) => !l.startsWith('#')).join('\n');

    it('copies only the allowlisted top-level keys into the generated config.toml', () => {
      const t = mk();
      fs.writeFileSync(path.join(t.real, 'config.toml'), [
        '# my config',
        'model = "gpt-5.5"',
        "model_reasoning_effort = 'high' # comment",
        'model_reasoning_summary = "detailed"',
        'model_verbosity = "low"',
        'model_provider = "openai"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'profile = "work"',
        '',
        '[mcp_servers.x]',
        'command = "x"',
        'model = "from-table"',
      ].join('\n'));
      const r = driver.createCodexIsolatedHome(t.env);
      expect(r.ok).toBe(true);
      expect(r.carried).toEqual(['model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'model_provider']);
      const toml = fs.readFileSync(path.join(r.dir, 'config.toml'), 'utf8');
      expect(toml).toBe(driver.codexWorkerConfigToml({
        model: 'gpt-5.5', model_reasoning_effort: 'high', model_reasoning_summary: 'detailed', model_verbosity: 'low', model_provider: 'openai',
      }));
      const body = bodyOf(toml);
      expect(body).toMatch(/^model = "gpt-5\.5"$/m);
      expect(body).toMatch(/^model_reasoning_effort = "high"$/m);
      expect(body).toMatch(/^model_provider = "openai"$/m);
      for (const banned of ['approval_policy', 'sandbox_mode', 'profile =', 'from-table', 'mcp_servers']) expect(body).not.toContain(banned);
      // carried keys come before the first table
      expect(body.indexOf('model = ')).toBeLessThan(body.indexOf('[features]'));
      driver.removeCodexIsolatedHome(r.dir);
      fs.rmSync(t.base, { recursive: true, force: true });
    });

    it('never copies disallowed keys or tables, even when they come before any table', () => {
      const text = [
        'mcp_servers.evil.command = "x"',
        'notify = ["x"]',
        'hooks = "x"',
        'base_url = "http://evil"',
        'env_key = "OPENAI"',
        'model_providers.evil.base_url = "http://evil"',
        'profiles.p.model = "x"',
        'projects."/w".trust_level = "trusted"',
        '"model" = "quoted-key"',
        '[model_providers.evil]',
        'base_url = "http://evil"',
        '[profiles.p]',
        'model = "p-model"',
        '[projects."/w"]',
        'trust_level = "trusted"',
      ].join('\n');
      expect(driver.parseCarriedCodexConfig(text)).toEqual({ values: {}, keys: [] });
      const body = bodyOf(driver.codexWorkerConfigToml({ notify: 'x', base_url: 'http://evil', mcp_servers: 'x', profile: 'p' } as Record<string, string>));
      for (const banned of ['notify', 'base_url', 'mcp_servers', 'profile']) expect(body).not.toContain(banned);
    });

    it('skips invalid values, non-built-in providers, duplicates, multi-line strings and non-strings', () => {
      const r = driver.parseCarriedCodexConfig([
        'model = "gpt 5"',
        'model_verbosity = "a\\"b"',
        'model_provider = "evilproxy"',
        `model_reasoning_summary = "${'x'.repeat(65)}"`,
        'model_reasoning_effort = 5',
        'x = """',
        'model = "inside-multiline"',
        '"""',
      ].join('\n'));
      expect(r).toEqual({ values: {}, keys: [] });
      expect(driver.parseCarriedCodexConfig('model = "a"\nmodel = "b"\n')).toEqual({ values: {}, keys: [] });
      expect(driver.parseCarriedCodexConfig('model = "o3:mini-2.0"\r\n')).toEqual({ values: { model: 'o3:mini-2.0' }, keys: ['model'] });
      expect(driver.parseCarriedCodexConfig(undefined)).toEqual({ values: {}, keys: [] });
      const body = bodyOf(driver.codexWorkerConfigToml({ model: 'bad"value', model_provider: 'evilproxy' }));
      expect(body).not.toContain('model');
    });

    it('an unreadable or missing real config carries nothing and the home is still made', () => {
      const t = mk();
      fs.rmSync(path.join(t.real, 'config.toml'));
      const r = driver.createCodexIsolatedHome(t.env);
      expect(r.ok).toBe(true);
      expect(r.carried).toEqual([]);
      expect(fs.readFileSync(path.join(r.dir, 'config.toml'), 'utf8')).toBe(driver.codexWorkerConfigToml());
      driver.removeCodexIsolatedHome(r.dir);
      fs.rmSync(t.base, { recursive: true, force: true });
    });
  });

  describe('AGENTS.md', () => {
    it('copies a regular AGENTS.md (a copy, not a link) and keeps the real one on removal', () => {
      const t = mk();
      fs.writeFileSync(path.join(t.real, 'AGENTS.md'), '# ClosePaw guide\n');
      const r = driver.createCodexIsolatedHome(t.env);
      expect(r.ok).toBe(true);
      expect(r.agentsMd).toBe('copied');
      const copy = path.join(r.dir, 'AGENTS.md');
      expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(copy, 'utf8')).toBe('# ClosePaw guide\n');
      fs.writeFileSync(copy, 'changed');
      expect(fs.readFileSync(path.join(t.real, 'AGENTS.md'), 'utf8')).toBe('# ClosePaw guide\n');
      driver.removeCodexIsolatedHome(r.dir);
      expect(fs.existsSync(path.join(t.real, 'AGENTS.md'))).toBe(true);
      fs.rmSync(t.base, { recursive: true, force: true });
    });

    it('accepts exactly 64 KiB, skips anything larger', () => {
      const t = mk();
      fs.writeFileSync(path.join(t.real, 'AGENTS.md'), 'a'.repeat(64 * 1024));
      const ok = driver.createCodexIsolatedHome(t.env);
      expect(ok.agentsMd).toBe('copied');
      expect(fs.statSync(path.join(ok.dir, 'AGENTS.md')).size).toBe(64 * 1024);
      driver.removeCodexIsolatedHome(ok.dir);
      fs.writeFileSync(path.join(t.real, 'AGENTS.md'), 'a'.repeat(64 * 1024 + 1));
      const big = driver.createCodexIsolatedHome(t.env);
      expect(big.ok).toBe(true);
      expect(big.agentsMd).toBe('skipped_too_large');
      expect(fs.existsSync(path.join(big.dir, 'AGENTS.md'))).toBe(false);
      driver.removeCodexIsolatedHome(big.dir);
      fs.rmSync(t.base, { recursive: true, force: true });
    });

    it('skips a symlinked AGENTS.md, a directory, and a missing one', () => {
      const t = mk();
      expect(driver.createCodexIsolatedHome(t.env).agentsMd).toBe('absent');
      fs.mkdirSync(path.join(t.real, 'AGENTS.md'));
      const d = driver.createCodexIsolatedHome(t.env);
      expect(d.agentsMd).toBe('skipped_not_file');
      expect(fs.existsSync(path.join(d.dir, 'AGENTS.md'))).toBe(false);
      fs.rmSync(path.join(t.real, 'AGENTS.md'), { recursive: true });
      const target = path.join(t.base, 'elsewhere.md');
      fs.writeFileSync(target, 'secret');
      let linked = true;
      try { fs.symlinkSync(target, path.join(t.real, 'AGENTS.md'), 'file'); } catch (_) { linked = false; }
      if (linked) {
        const s = driver.createCodexIsolatedHome(t.env);
        expect(s.ok).toBe(true);
        expect(s.agentsMd).toBe('skipped_symlink');
        expect(fs.existsSync(path.join(s.dir, 'AGENTS.md'))).toBe(false);
      }
      fs.rmSync(t.base, { recursive: true, force: true });
    });
  });

  it('the app-server (and preflight) spawn env carries the isolated CODEX_HOME', () => {
    const spec = driver.codexAppServerSpawnSpec({ codexBin: 'codex', codexHome: '/iso/home' });
    expect(spec.env.CODEX_HOME).toBe('/iso/home');
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
const path = require('path');
const readline = require('readline');
fs.writeFileSync(process.env.FAKE_ARGV_RECORD, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_HOME_RECORD) {
  const h = process.env.CODEX_HOME || '';
  const authPath = path.join(h, 'auth.json');
  let auth;
  try {
    const st = fs.lstatSync(authPath);
    auth = { symlink: st.isSymbolicLink(), target: st.isSymbolicLink() ? fs.readlinkSync(authPath) : null, content: fs.readFileSync(authPath, 'utf8') };
  } catch (e) { auth = { error: e.code }; }
  let config = null;
  try { config = fs.readFileSync(path.join(h, 'config.toml'), 'utf8'); } catch (_) {}
  let entries = null;
  try { entries = fs.readdirSync(h).sort(); } catch (_) {}
  let mode = null;
  try { mode = fs.statSync(h).mode & 0o777; } catch (_) {}
  fs.writeFileSync(process.env.FAKE_HOME_RECORD, JSON.stringify({ codexHome: h, entries, config, auth, mode }));
}
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

  function run(script: Msg[], env: Record<string, string> = {}, real: { configPrefix?: string; agentsMd?: string } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-'));
    const ws = path.join(home, 'demo');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'app-server'), FAKE_APP_SERVER);
    fs.writeFileSync(path.join(ws, 'mcp'), FAKE_CODEX_MCP_LIST);
    // The user's real Codex home: config with an MCP server + login.
    const realHome = path.join(home, 'real-codex');
    fs.mkdirSync(realHome);
    fs.writeFileSync(path.join(realHome, 'config.toml'), `${real.configPrefix || ''}[mcp_servers.realsrv]\ncommand = "x"\nnotify = ["x"]\n`);
    fs.writeFileSync(path.join(realHome, 'auth.json'), '{"REAL":"AUTH"}');
    if (real.agentsMd !== undefined) fs.writeFileSync(path.join(realHome, 'AGENTS.md'), real.agentsMd);
    const tmpParent = path.join(home, 'tmp');
    fs.mkdirSync(tmpParent);
    const homeRec = path.join(home, 'home.json');
    const mcpHomeRec = path.join(home, 'mcp-home.txt');
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
        CODEX_HOME: realHome,
        TMPDIR: tmpParent,
        FAKE_SCRIPT: JSON.stringify(script),
        FAKE_RECORD: rec,
        FAKE_ARGV_RECORD: argvRec,
        FAKE_HOME_RECORD: homeRec,
        FAKE_MCP_HOME_RECORD: mcpHomeRec,
        ...env,
      },
    });
    const read = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
    const leftover = fs.statSync(tmpParent).isDirectory()
      ? fs.readdirSync(tmpParent).filter((n) => n.startsWith(driver.CODEX_ISOLATED_HOME_PREFIX))
      : [];
    const result = {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      responses: read(rec),
      appServerArgv: read(argvRec) as string[] | null,
      answerWritten: fs.existsSync(answerFile),
      audit: fs.existsSync(auditLog) ? fs.readFileSync(auditLog, 'utf8') : '',
      workerHome: read(homeRec),
      mcpListHomes: fs.existsSync(mcpHomeRec) ? fs.readFileSync(mcpHomeRec, 'utf8').split('\n').filter(Boolean) : [],
      leftover,
      realHome,
      tmpParent,
      realAuthAfter: fs.existsSync(path.join(realHome, 'auth.json')) ? fs.readFileSync(path.join(realHome, 'auth.json'), 'utf8') : null,
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

  it('the worker and its preflight run with an isolated CODEX_HOME that is removed afterwards', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    const w = r.workerHome;
    expect(w).not.toBeNull();
    expect(w.codexHome).not.toBe('');
    expect(path.resolve(w.codexHome)).not.toBe(path.resolve(r.realHome));
    expect(path.dirname(w.codexHome)).toBe(r.tmpParent);
    expect(path.basename(w.codexHome).startsWith(driver.CODEX_ISOLATED_HOME_PREFIX)).toBe(true);
    // the user's config (MCP server, notify) is not there; only the generated one
    expect(w.entries).toEqual(['auth.json', 'config.toml']);
    expect(w.config).toBe(driver.codexWorkerConfigToml());
    expect(w.config).not.toMatch(/^\[mcp_servers/m);
    expect(w.config).not.toContain('realsrv');
    // login via a symlink to the real auth.json
    expect(w.auth.symlink).toBe(true);
    expect(path.resolve(w.codexHome, w.auth.target)).toBe(path.join(r.realHome, 'auth.json'));
    expect(w.auth.content).toBe('{"REAL":"AUTH"}');
    if (process.platform !== 'win32') expect(w.mode).toBe(0o700);
    // the preflight listing saw the same isolated home
    expect(r.mcpListHomes).toEqual([w.codexHome]);
    // removed on finish; the real login is untouched
    expect(r.leftover).toEqual([]);
    expect(fs.existsSync(w.codexHome)).toBe(false);
    expect(r.realAuthAfter).toBe('{"REAL":"AUTH"}');
    const start = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'driver_start');
    expect(start.codexHome).toBe('isolated');
    expect(start.codexHomeCarried).toEqual([]);
    expect(start.codexHomeAgentsMd).toBe('absent');
    expect(r.audit).not.toContain('codex_isolated_auth_replaced');
  }, 60_000);

  it('the worker home carries the allowlisted model settings and a copy of AGENTS.md; driver_start records them', () => {
    const r = run([], {}, {
      configPrefix: 'model = "gpt-5.5"\nmodel_provider = "evilproxy"\nnotify = ["x"]\nmodel_reasoning_effort = "high"\n',
      agentsMd: '# ClosePaw guide\n',
    });
    expect(r.status).toBe(0);
    const w = r.workerHome;
    expect(w.entries).toEqual(['AGENTS.md', 'auth.json', 'config.toml']);
    expect(w.config).toBe(driver.codexWorkerConfigToml({ model: 'gpt-5.5', model_reasoning_effort: 'high' }));
    expect(w.config).not.toContain('evilproxy');
    expect(w.config).not.toContain('realsrv');
    expect(w.config.split('\n').filter((l: string) => !l.startsWith('#')).join('\n')).not.toContain('notify');
    const start = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'driver_start');
    expect(start.codexHomeCarried).toEqual(['model', 'model_reasoning_effort']);
    expect(start.codexHomeAgentsMd).toBe('copied');
    expect(r.audit).not.toContain('gpt-5.5');
    expect(r.leftover).toEqual([]);
  }, 60_000);

  it('the isolated home is also removed when the run fails', () => {
    const r = run([
      { method: 'mcpServer/startupStatus/updated', params: { name: 'codex_apps', status: 'ready' } },
    ]);
    expect(r.status).toBe(1);
    expect(r.workerHome).not.toBeNull();
    expect(r.leftover).toEqual([]);
  }, 60_000);

  it('no isolated home (TMPDIR unusable) → Codex and its preflight never start, the run fails closed', () => {
    const blocker = path.join(os.tmpdir(), `codex-iso-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'not a directory');
    try {
      const r = run([], { TMPDIR: blocker });
      expect(r.status).toBe(1);
      expect(r.appServerArgv).toBeNull();
      expect(r.mcpListHomes).toEqual([]);
      expect(auditKinds(r.audit)).toEqual(expect.arrayContaining(['driver_start', 'codex_home_isolation_failed', 'driver_finish']));
      expect(auditKinds(r.audit)).not.toContain('codex_mcp_preflight_failed');
      const start = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'driver_start');
      expect(start.codexHome).toBe('isolation_failed');
    } finally {
      fs.rmSync(blocker, { force: true });
    }
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
    // The audit log never carries MCP arguments. (The driver's raw wire log on
    // stdout — the `S->C …` lines — still echoes the message verbatim,
    // arguments included; that is existing behavior and not changed here.)
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
      { id: 'el-1', method: 'mcpServer/elicitation/request', params: { threadId: 'th1', turnId: 't1', serverName: 'mercari', mode: 'form', message: `Confirm purchase? ${SECRET_ARG}`, requestedSchema: { default: SECRET_ARG } } },
    ]);
    expect(r.audit).not.toContain(SECRET_ARG);
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

  it('MCP tool-call progress is blocked without recording its payload', () => {
    const r = run([
      { method: 'item/mcpToolCall/progress', params: { threadId: 'th1', turnId: 't1', itemId: 'mcp-3', message: SECRET_ARG } },
    ]);
    expect(r.status).toBe(1);
    expect(r.audit).toContain('"phase":"progress"');
    expect(r.audit).not.toContain(SECRET_ARG);
    expect(r.answerWritten).toBe(false);
  }, 60_000);

  it('an MCP server reported as starting / ready (e.g. codex_apps) fails the run before any tool call', () => {
    const r = run([
      { method: 'mcpServer/startupStatus/updated', params: { name: 'codex_apps', status: 'ready', error: SECRET_ARG } },
    ]);
    expect(r.status).toBe(1);
    const blocked = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'mcp_server_startup_blocked');
    expect(blocked).toEqual(expect.objectContaining({ server: 'codex_apps', status: 'ready' }));
    expect(r.out).toMatch(/C->S \{"id":\d+,"method":"turn\/interrupt","params":\{"threadId":"th1","turnId":"t1"\}\}/);
    expect(r.audit).not.toContain(SECRET_ARG);
    expect(r.answerWritten).toBe(false);
    expect(auditKinds(r.audit)).not.toContain('turn_completed');

    for (const status of ['starting', 'connecting', 'running', 'somethingNew']) {
      const s = run([{ method: 'mcpServer/startupStatus/updated', params: { name: 'mercari', status } }]);
      expect(s.status).toBe(1);
      expect(s.audit).toContain('mcp_server_startup_blocked');
    }
    const missing = run([{ method: 'mcpServer/startupStatus/updated', params: { name: 'mercari' } }]);
    expect(missing.status).toBe(1);
    expect(missing.audit).toContain('mcp_server_startup_blocked');
  }, 180_000);

  it('a disabled / not-started / failed server status is recorded and the run still succeeds', () => {
    const r = run([
      { method: 'mcpServer/startupStatus/updated', params: { name: 'mercari', status: 'disabled' } },
      { method: 'mcpServer/startupStatus/updated', params: { name: 'shelly-phone', status: 'not_started' } },
      { method: 'mcpServer/startupStatus/updated', params: { name: 'x', status: { failed: { error: SECRET_ARG } } } },
    ]);
    expect(r.status).toBe(0);
    expect(r.answerWritten).toBe(true);
    expect(auditKinds(r.audit)).not.toContain('mcp_server_startup_blocked');
    const observed = r.audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'mcp_server_startup_observed');
    expect(observed.map((e) => e.status)).toEqual(['disabled', 'not_started', 'failed']);
    expect(r.audit).not.toContain(SECRET_ARG);
  }, 60_000);
});
