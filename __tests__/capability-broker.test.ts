import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BROKER = path.resolve(__dirname, '..', 'scripts', 'shelly-capability-broker.js');

// The broker guards its CLI entry point with `if (require.main === module)`
// specifically so its pure helper functions (parseEnvFile, scrubEnvValue,
// evaluateSecretFileMode, checkSecretFilePermissions, describeDenySignal,
// describeApproveSignal, formatBudgetExceededMessage) can be unit-tested
// in-process, in addition to the black-box subprocess tests above. Requiring
// it here does NOT run main() / does NOT process.exit.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const brokerInternals = require(BROKER) as {
  parseEnvFile: (filePath: string, wantedKey?: string) => Record<string, string>;
  scrubEnvValue: (env: Record<string, unknown>, key: string) => void;
  evaluateSecretFileMode: (mode: number, platform: string) => { ok: boolean; reason?: string };
  checkSecretFilePermissions: (filePath: string) => { ok: boolean; reason?: string };
  describeDenySignal: (verdict: any, authRef: string | null) => { category: string; explanation: string };
  describeApproveSignal: (verdict: any, authRef: string | null) => { category: string; explanation: string };
  formatBudgetExceededMessage: (state: any, budget: any, nowMs: number) => string;
};

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
    approval?: {
      dir: string;
      replyDir: string;
      agentId?: string;
      agentName?: string;
      runId?: string;
      timeoutSeconds?: number;
    };
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
  if (opts.approval) {
    argv.push(
      '--approval-dir',
      opts.approval.dir,
      '--approval-reply-dir',
      opts.approval.replyDir,
      '--agent-id',
      opts.approval.agentId || 'agent1',
      '--agent-name',
      opts.approval.agentName || '',
      '--run-id',
      opts.approval.runId || 'run1',
      '--approval-timeout-seconds',
      String(opts.approval.timeoutSeconds ?? 10),
    );
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
    // 2026-07-17 diagnostic-display follow-up: the err message names the
    // specific policy check that failed (auth_ref/host binding), not just
    // classifyEgress's raw reason string.
    expect(r.err).toContain('[auth-ref-host-mismatch]');
    expect(r.err).toContain('perplexity');
  });

  it('DENYs plaintext http to a remote host', async () => {
    const r = await runBroker(dir, { url: 'http://api.groq.com/x' });
    expect(r.code).toBe(40);
    expect(r.audit[0].signals).toContain('insecure-scheme');
    expect(r.err).toContain('[insecure-scheme]');
  });

  it('DENYs an unrecognized auth_ref name', async () => {
    const r = await runBroker(dir, { url: 'https://api.perplexity.ai/chat/completions', authRef: 'not-a-real-ref' });
    expect(r.code).toBe(40);
    expect(r.audit[0].decision).toBe('deny');
    expect(r.err).toContain('[unknown-auth-ref]');
    expect(r.err).toContain('not-a-real-ref');
  });

  it('blocks a non-allowlist host fail-closed when not approved (41)', async () => {
    const r = await runBroker(dir, { url: 'https://hooks.example.com/incoming' });
    expect(r.code).toBe(41);
    expect(r.audit[0].decision).toBe('approve');
    expect(r.audit[0].signals).toContain('non-allowlist-host');
    expect(r.err).toContain('[non-allowlist-host]');
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
    expect(r.err).toContain('[tainted-secret-spend]');
  });

  it('fails closed with BUDGET (42) when the call budget is exhausted, with real limit/usage numbers', async () => {
    const r = await runBroker(dir, {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      authRef: 'groq',
      env: { GROQ_API_KEY: 'gsk_SECRETSECRETSECRETSECRET' },
      budget: { calls: 40, startedAtMs: Date.now() },
    });
    expect(r.code).toBe(42);
    expect(r.err).toMatch(/budget/);
    // 2026-07-17 diagnostic-display follow-up: real configured limits (40
    // calls / 10 min) and real current usage (40 calls made), not a bare
    // "budget exhausted" string.
    expect(r.err).toContain('40 calls / 10 min budget exceeded');
    expect(r.err).toContain('made 40 call(s)');
  });
});

// 2026-07-17 follow-up (docs/superpowers/DEFERRED.md "Capability broker
// Phase 0" mid-run host approval). These prove the new opt-in behaviour
// (only engaged when --approval-dir/--approval-reply-dir/--agent-id/--run-id
// are ALL supplied) without touching the pre-existing "immediate 41" test
// above, which intentionally omits those args and must keep failing closed
// with zero waiting — the regression guard for every caller that hasn't been
// wired to the new args yet.
describe('shelly-capability-broker: mid-run host approval (nonce/host/run binding)', () => {
  let dir: string;
  let approvalDir: string;
  let approvalReplyDir: string;
  beforeEach(() => {
    dir = makeDir();
    approvalDir = path.join(dir, 'approvals');
    approvalReplyDir = path.join(dir, 'approval-replies');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function firstRequestFile(): string {
    const files = fs.readdirSync(approvalDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    return path.join(approvalDir, files[0]);
  }

  function writeReply(requestFile: string, overrides: Partial<{ runId: string; host: string; nonce: string; decision: string }> = {}) {
    const req = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const replyName = path.basename(requestFile).replace(/\.json$/, '.reply.json');
    const reply = {
      runId: req.runId,
      host: req.host,
      nonce: req.nonce,
      decision: 'accept',
      ...overrides,
    };
    fs.writeFileSync(path.join(approvalReplyDir, replyName), JSON.stringify(reply));
  }

  it('(a) writes a nonce-bound approval-request file for a non-allowlist host instead of failing immediately', async () => {
    const runPromise = runBroker(dir, {
      url: 'https://hooks.example.com/incoming',
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-a', timeoutSeconds: 5 },
    });
    // Give the broker a moment to write the request before it's resolved.
    await new Promise((r) => setTimeout(r, 300));
    const reqFile = firstRequestFile();
    const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
    expect(req.type).toBe('cap-broker-host');
    expect(req.runId).toBe('run-a');
    expect(req.host).toBe('hooks.example.com');
    expect(typeof req.nonce).toBe('string');
    expect(req.nonce.length).toBeGreaterThanOrEqual(16);
    // Let it time out (no reply written) so the test doesn't hang past this point.
    const r = await runPromise;
    expect(r.code).toBe(41);
    expect(r.audit.some((e: any) => e.kind === 'http.request.approval' && e.stage === 'requested')).toBe(true);
  }, 15000);

  it('(b) a valid accept reply (matching nonce/host/run) lets the request through', async () => {
    const runPromise = runBroker(dir, {
      url: 'https://hooks.example.com/incoming',
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-b', timeoutSeconds: 10 },
    });
    await new Promise((r) => setTimeout(r, 300));
    const reqFile = firstRequestFile();
    writeReply(reqFile);
    const r = await runPromise;
    // The request itself then goes out over the network and fails DNS
    // resolution (hooks.example.com is not a real reachable host in the test
    // sandbox) — exit 23, NOT 41. The important assertion is that it is no
    // longer 41 (approval-required): the mid-run approval was consumed and
    // the broker proceeded to actually attempt the send.
    expect(r.code).not.toBe(41);
    expect(r.audit.some((e: any) => e.kind === 'http.request.approval' && e.stage === 'accepted' && e.approved === true)).toBe(true);
  }, 15000);

  it('(c) a reply with a mismatched nonce is rejected and fails closed', async () => {
    const runPromise = runBroker(dir, {
      url: 'https://hooks.example.com/incoming',
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-c', timeoutSeconds: 10 },
    });
    await new Promise((r) => setTimeout(r, 300));
    const reqFile = firstRequestFile();
    writeReply(reqFile, { nonce: 'not-the-real-nonce' });
    const r = await runPromise;
    expect(r.code).toBe(41);
    expect(r.audit.some((e: any) => e.kind === 'http.request.approval' && e.stage === 'mismatch' && e.approved === false)).toBe(true);
  }, 15000);

  it('(c) a reply with a mismatched host is rejected and fails closed', async () => {
    const runPromise = runBroker(dir, {
      url: 'https://hooks.example.com/incoming',
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-c2', timeoutSeconds: 10 },
    });
    await new Promise((r) => setTimeout(r, 300));
    const reqFile = firstRequestFile();
    writeReply(reqFile, { host: 'evil.example.com' });
    const r = await runPromise;
    expect(r.code).toBe(41);
    expect(r.audit.some((e: any) => e.kind === 'http.request.approval' && e.stage === 'mismatch')).toBe(true);
  }, 15000);

  it('(d) timeout with no reply fails closed exactly as the immediate-fail-closed path does (41)', async () => {
    const r = await runBroker(dir, {
      url: 'https://hooks.example.com/incoming',
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-d', timeoutSeconds: 1 },
    });
    expect(r.code).toBe(41);
    expect(r.audit.some((e: any) => e.kind === 'http.request.approval' && e.stage === 'timeout' && e.approved === false)).toBe(true);
    // The request file is cleaned up on timeout, same as wait_action_approval's
    // precedent in lib/agent-executor.ts.
    expect(fs.readdirSync(approvalDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  }, 15000);

  it('(e) an allowlisted host is COMPLETELY UNCHANGED even when approval args are supplied (no request file, no waiting)', async () => {
    const started = Date.now();
    const r = await runBroker(dir, {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      authRef: 'groq',
      env: { GROQ_API_KEY: 'gsk_SECRETSECRETSECRETSECRET' },
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-e', timeoutSeconds: 10 },
    });
    const elapsedMs = Date.now() - started;
    // Never waits the approval timeout — proceeds straight to the (failing,
    // no real network target) send. Comfortably under the 10s approval
    // timeout configured above.
    expect(elapsedMs).toBeLessThan(5000);
    expect(fs.existsSync(approvalDir) ? fs.readdirSync(approvalDir) : []).toHaveLength(0);
    expect(r.audit.every((e: any) => e.kind !== 'http.request.approval')).toBe(true);
    expect(r.audit[0].decision).toBe('allow');
  }, 15000);

  it('a tainted-secret-spend "approve" verdict on an allowlisted host is NEVER offered mid-run approval (stays immediate 41)', async () => {
    const r = await runBroker(dir, {
      url: 'https://api.perplexity.ai/chat/completions',
      authRef: 'perplexity',
      tainted: true,
      env: { PERPLEXITY_API_KEY: 'pplx-SECRETSECRETSECRETSECRET' },
      approval: { dir: approvalDir, replyDir: approvalReplyDir, runId: 'run-f', timeoutSeconds: 10 },
    });
    expect(r.code).toBe(41);
    expect(fs.existsSync(approvalDir) ? fs.readdirSync(approvalDir) : []).toHaveLength(0);
    expect(r.audit.every((e: any) => e.kind !== 'http.request.approval')).toBe(true);
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

// 2026-07-17 follow-up (docs/superpowers/DEFERRED.md "Capability broker
// Phase 0" — "SECRET-001 は部分適用...完全 de-source は follow-up"). Unit
// tests for the pure helpers (in-process, via the require.main guard) plus
// one black-box integration test for the permission gate wired into main().
describe('shelly-capability-broker: SECRET-001 full de-source', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parseEnvFile(path, wantedKey) only materializes the ONE requested secret, never the others in the same file', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(
      envFile,
      "PERPLEXITY_API_KEY='pplx-SECRETSECRETSECRETSECRET'\nGEMINI_API_KEY='AIza-OTHERSECRETOTHERSECRET'\nGROQ_API_KEY='gsk_YETANOTHERSECRETVALUE'\n",
    );
    const scoped = brokerInternals.parseEnvFile(envFile, 'PERPLEXITY_API_KEY');
    expect(scoped).toEqual({ PERPLEXITY_API_KEY: 'pplx-SECRETSECRETSECRETSECRET' });
    expect(Object.keys(scoped)).toHaveLength(1);
    expect(scoped).not.toHaveProperty('GEMINI_API_KEY');
    expect(scoped).not.toHaveProperty('GROQ_API_KEY');

    // Unfiltered call (no wantedKey) keeps returning everything — used by no
    // live call site today, but proves the filter is additive, not a
    // behaviour change for any hypothetical future caller that wants the
    // full map.
    const all = brokerInternals.parseEnvFile(envFile);
    expect(Object.keys(all).sort()).toEqual(['GEMINI_API_KEY', 'GROQ_API_KEY', 'PERPLEXITY_API_KEY']);
  });

  it('scrubEnvValue drops the resolved secret from the in-memory env object', () => {
    const env: Record<string, string | null> = { PERPLEXITY_API_KEY: 'pplx-SECRETSECRETSECRETSECRET' };
    brokerInternals.scrubEnvValue(env, 'PERPLEXITY_API_KEY');
    expect(env.PERPLEXITY_API_KEY).toBeNull();
    // Never throws / no-ops cleanly on an absent key.
    expect(() => brokerInternals.scrubEnvValue(env, 'NOT_PRESENT')).not.toThrow();
  });

  it('evaluateSecretFileMode denies group/world-accessible modes on a real (non-Windows) platform with a clear reason', () => {
    const tooOpen = brokerInternals.evaluateSecretFileMode(0o100644, 'linux');
    expect(tooOpen.ok).toBe(false);
    expect(tooOpen.reason).toContain('644');
    expect(tooOpen.reason).toContain('600');

    const worldWritable = brokerInternals.evaluateSecretFileMode(0o100666, 'linux');
    expect(worldWritable.ok).toBe(false);
  });

  it('evaluateSecretFileMode allows an owner-only mode on a real (non-Windows) platform', () => {
    expect(brokerInternals.evaluateSecretFileMode(0o100600, 'linux')).toEqual({ ok: true });
  });

  it('evaluateSecretFileMode is a no-op on win32 (no real POSIX permission bits to check)', () => {
    // Windows synthesizes ~0o666 for any writable file regardless of real
    // ACLs, so enforcing this check there would false-positive on every
    // file; the production target (Android) is where it applies for real.
    expect(brokerInternals.evaluateSecretFileMode(0o100644, 'win32')).toEqual({ ok: true });
    expect(brokerInternals.evaluateSecretFileMode(0o100666, 'win32')).toEqual({ ok: true });
  });

  it('checkSecretFilePermissions does not fail-closed on a missing .env file (lets the normal NO_SECRET path report it)', () => {
    const missing = path.join(dir, 'does-not-exist', '.env');
    expect(brokerInternals.checkSecretFilePermissions(missing)).toEqual({ ok: true });
  });

  // Real filesystem permission enforcement is only meaningful where the host
  // OS actually has POSIX group/other bits — Windows dev machines (this
  // suite's normal CI/local environment) cannot construct a genuinely
  // insecure-mode file via fs.chmodSync (it only toggles the read-only DOS
  // attribute), so this integration-level check is gated to POSIX hosts.
  // Windows coverage for the underlying rule lives in the
  // evaluateSecretFileMode unit tests above, which are host-OS-independent.
  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('main() fails closed with a clear permission message when the real .env file is group/world-readable (POSIX only)', async () => {
    const insecureEnvFile = path.join(dir, '.env');
    fs.writeFileSync(insecureEnvFile, "PERPLEXITY_API_KEY='pplx-SECRETSECRETSECRETSECRET'\n");
    fs.chmodSync(insecureEnvFile, 0o644);
    const outFile = path.join(dir, 'out.txt');
    const errFile = path.join(dir, 'err.txt');
    const bodyFile = path.join(dir, 'body.json');
    fs.writeFileSync(bodyFile, '{}');
    await new Promise<void>((resolve) => {
      execFile(
        'node',
        [
          BROKER,
          '--method', 'POST',
          '--url', 'https://api.perplexity.ai/chat/completions',
          '--body-file', bodyFile,
          '--auth-ref', 'perplexity',
          '--secret-env-file', insecureEnvFile,
          '--out', outFile,
          '--err', errFile,
          '--timeout-seconds', '5',
        ],
        { encoding: 'utf8' },
        (err: any) => {
          expect(err).not.toBeNull();
          expect(typeof err.code).toBe('number');
          expect(err.code).toBe(43); // EXIT.NO_SECRET
          const errText = fs.readFileSync(errFile, 'utf8');
          expect(errText).toContain('insecure permissions');
          expect(errText).toContain('600');
          expect(errText).not.toContain('pplx-SECRET');
          resolve();
        },
      );
    });
  });
});
