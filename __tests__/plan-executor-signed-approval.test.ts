// 署名付き承認 (SIGNED-APPROVAL) Migration step 2 — executor-side verifier tests.
//
// Two layers, matching the task's two risk surfaces:
//  1. Spawn-the-real-executor smoke test: confirms that with
//     SIGNED_APPROVAL_ENABLED hardcoded false in scripts/shelly-plan-executor.js,
//     today's naive {runId, requestSha256, decision} equality accept-path is
//     UNCHANGED — a plain unsigned reply is still accepted exactly as before this
//     work landed. This is the single most important invariant in the task.
//  2. Pure unit tests against the ported canonical/verify functions, exercised
//     directly via the executor's module.exports (added purely for testability;
//     SIGNED_APPROVAL_ENABLED still gates all production use of these exports).
//     Covers: valid signed reply -> ok:true; tampered request/reply/signature/
//     expired/wrong-key/nonce-replay/wrong-sigAlg each -> ok:false with the
//     specific VerifyReason, mirroring __tests__/signed-approval/verify.test.ts.

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const executorPath = path.join(root, 'scripts', 'shelly-plan-executor.js');
const brokerPath = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(executorPath);

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-signed-approval-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makePlan(home: string, port: number) {
  const agentId = 'agent-signed-approval-smoke';
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    // requireActionApproval: true keeps this fixture exercising the full
    // write+wait approval round trip (project owner directive 2026-07-14 made
    // draft/notify/webhook/cli skip that round trip by default otherwise).
    agent: { id: agentId, name: 'Signed Approval Smoke', autonomous: true, autonomyLevel: 'L2', requireActionApproval: true },
    prompt: 'say hello',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'signed-approval-smoke',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
  return { plan, planFile };
}

function runExecutor(args: string[], home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The executor exits 0 for BOTH an accepted action and a declined/skipped one
// (ActionSkipped is a normal outcome, not a process error) -- the actual
// accept/reject verdict only shows up in the run log written to
// .shelly/agents/logs/<agentId>/<unix-seconds>.json, so tests asserting
// accept-vs-reject must read that file rather than the process exit code.
function readLatestRunLog(home: string, agentId: string): { status: string; errorMessage: string } {
  const runLogDir = path.join(home, '.shelly/agents/logs', agentId);
  const runLogs = fs.readdirSync(runLogDir).filter((name) => /^\d+\.json$/.test(name));
  expect(runLogs.length).toBeGreaterThan(0);
  const latest = runLogs.sort().pop()!;
  return JSON.parse(fs.readFileSync(path.join(runLogDir, latest), 'utf8'));
}

async function readNextActionRequest(home: string): Promise<{ file: string; request: any; sha: string }> {
  const requestDir = path.join(home, '.shelly/agents/action-approvals');
  for (let i = 0; i < 100; i += 1) {
    const requests = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'))
      : [];
    if (requests.length > 0) {
      const file = path.join(requestDir, requests[0]);
      const bytes = fs.readFileSync(file);
      return {
        file,
        request: JSON.parse(bytes.toString('utf8')),
        sha: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }
    await delay(50);
  }
  throw new Error('timed out waiting for action approval request');
}

describe('shelly-plan-executor signed-approval dormancy (SIGNED_APPROVAL_ENABLED=false)', () => {
  let server: http.Server;
  let port = 0;

  beforeEach((done) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: `fixture result: ${parsed.messages[0].content}` } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('exports SIGNED_APPROVAL_ENABLED = false (mirrors lib/signed-approval/wiring.ts)', () => {
    expect(executor.SIGNED_APPROVAL_ENABLED).toBe(false);
  });

  it('REGRESSION: the on-disk request.requestSha256 (written by the REAL requestActionApproval) equals sha256(canonicalApprovalRequest(...)), not sha256 of the raw file bytes', async () => {
    // This is the end-to-end wiring proof the pure unit tests below cannot give:
    // they construct request.requestSha256 by hand via the same helper this test
    // now checks against production output, so they would not have caught the
    // original bug where requestActionApproval never set the field at all (it
    // stayed `undefined`), nor a follow-up mistake of setting it to
    // sha256File(requestFile) (the file-bytes hash used by the UNRELATED naive
    // equality path) instead of the canonical-encoding hash verifySignedApprovalReply
    // actually recomputes. Both would make the signed-approval accept-path
    // self-DoS on every reply once SIGNED_APPROVAL_ENABLED is ever flipped true.
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const run = runExecutor([
      executorPath,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', brokerPath,
    ], home);

    const pending = await readNextActionRequest(home);
    expect(typeof pending.request.requestSha256).toBe('string');
    expect(pending.request.requestSha256.length).toBe(64); // hex sha256

    const canonicalHash = crypto
      .createHash('sha256')
      .update(executor.canonicalApprovalRequest(pending.request))
      .digest('hex');
    expect(pending.request.requestSha256).toBe(canonicalHash);

    // And it must NOT equal the file-bytes hash (`pending.sha`, the naive path's
    // own hash of the on-disk JSON) -- if it did, canonicalApprovalRequest's
    // encoding and the raw file serialization would have collided, which would
    // itself be a red flag (or, more likely, indicate the fix regressed back to
    // hashing file bytes instead of the canonical array).
    expect(pending.request.requestSha256).not.toBe(pending.sha);

    // Let the run complete cleanly via the naive path (SIGNED_APPROVAL_ENABLED
    // is false, so this is the only path reachable regardless).
    const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
    fs.mkdirSync(replyDir, { recursive: true });
    fs.writeFileSync(
      path.join(replyDir, `action-${pending.request.runId}.reply.json`),
      JSON.stringify({
        runId: pending.request.runId,
        decision: 'accept',
        by: 'test',
        requestSha256: pending.sha,
        ts: new Date().toISOString(),
      }) + '\n',
    );
    const result = await run;
    expect(result.status).toBe(0);
  });

  it('request object now carries a nonce field, but the naive-equality accept-path is unchanged: a plain unsigned reply is still accepted', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const run = runExecutor([
      executorPath,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', brokerPath,
    ], home);

    const pending = await readNextActionRequest(home);
    expect(pending.request.actionType).toBe('draft');
    // New field exists (added to the request object per the task)...
    expect(typeof pending.request.nonce).toBe('string');
    expect(pending.request.nonce.length).toBe(32); // crypto.randomBytes(16).toString('hex')

    // ...but the accept-path check is still exactly {runId, requestSha256, decision}
    // equality: a reply with none of sigAlg/signature/keySha256/nonce set is
    // accepted exactly as it was before this task, proving the flag-false path is
    // byte-identical to the pre-existing naive check.
    const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
    fs.mkdirSync(replyDir, { recursive: true });
    fs.writeFileSync(
      path.join(replyDir, `action-${pending.request.runId}.reply.json`),
      JSON.stringify({
        runId: pending.request.runId,
        decision: 'accept',
        by: 'test',
        requestSha256: pending.sha,
        ts: new Date().toISOString(),
      }) + '\n',
    );

    const result = await run;
    expect(result.status).toBe(0);
  });

  it('a reply carrying signature-like fields (sigAlg/signature/keySha256/nonce) is STILL accepted by naive equality alone while the flag is false (the extra fields are inert)', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const run = runExecutor([
      executorPath,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', brokerPath,
    ], home);

    const pending = await readNextActionRequest(home);
    const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
    fs.mkdirSync(replyDir, { recursive: true });
    // A reply that LOOKS signed (has sigAlg/signature/keySha256/nonce) but with a
    // garbage signature. If SIGNED_APPROVAL_ENABLED were true this would be
    // rejected (bad-signature); since it is hardcoded false, the executor never
    // even looks at these fields and falls straight to the naive equality check,
    // which passes because runId/requestSha256/decision match.
    fs.writeFileSync(
      path.join(replyDir, `action-${pending.request.runId}.reply.json`),
      JSON.stringify({
        runId: pending.request.runId,
        decision: 'accept',
        by: 'human',
        requestSha256: pending.sha,
        nonce: pending.request.nonce,
        sigAlg: 'SHA256withRSA',
        signature: 'not-a-real-signature',
        keySha256: 'deadbeef',
        ts: new Date().toISOString(),
      }) + '\n',
    );

    const result = await run;
    expect(result.status).toBe(0);
  });
});

// ─── Regression: flag-ON must fail closed on an unsigned/malformed reply ───
//
// SIGNED_APPROVAL_ENABLED is a hardcoded `false` constant in the executor
// source, so exercising the flag-ON branch requires spawning a patched copy
// with that one line flipped -- everything else byte-identical to the real
// script. This proves the specific fix for the review finding: once enabled,
// a reply missing sigAlg/signature/keySha256/nonce must be REJECTED rather
// than silently falling through to the naive runId+requestSha256 equality
// check (which would let an attacker bypass signature verification simply by
// omitting the signature fields).
describe('shelly-plan-executor signed-approval enabled (fail-closed on unsigned reply)', () => {
  let server: http.Server;
  let port = 0;
  let patchedExecutorPath: string;

  beforeAll(() => {
    const source = fs.readFileSync(executorPath, 'utf8');
    const patched = source.replace(
      'const SIGNED_APPROVAL_ENABLED = false;',
      'const SIGNED_APPROVAL_ENABLED = true;',
    );
    expect(patched).not.toBe(source); // fail loudly if the constant's source text ever changes shape
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-signed-on-'));
    patchedExecutorPath = path.join(dir, 'shelly-plan-executor.js');
    fs.writeFileSync(patchedExecutorPath, patched);
  });

  beforeEach((done) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: `fixture result: ${parsed.messages[0].content}` } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('rejects a plain unsigned reply (the naive-check shape) when SIGNED_APPROVAL_ENABLED is true, instead of accepting it', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const run = runExecutor([
      patchedExecutorPath,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', brokerPath,
    ], home);

    const pending = await readNextActionRequest(home);
    const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
    fs.mkdirSync(replyDir, { recursive: true });
    // The exact same unsigned reply shape that IS accepted while the flag is
    // false (see the sibling test above) -- no sigAlg/signature/keySha256/nonce.
    fs.writeFileSync(
      path.join(replyDir, `action-${pending.request.runId}.reply.json`),
      JSON.stringify({
        runId: pending.request.runId,
        decision: 'accept',
        by: 'test',
        requestSha256: pending.sha,
        ts: new Date().toISOString(),
      }) + '\n',
    );

    await run;
    // ActionSkipped (a declined/rejected action) is a NORMAL outcome as far as
    // the process exit code is concerned -- both "approved" and "declined" exit
    // 0, the same way a human tapping Reject in the Review UI isn't a process
    // error. The actual accept/reject outcome is recorded in the run log, so
    // that's what proves whether this reply was accepted or rejected.
    // Before the fix, this reply would satisfy the naive equality check
    // (runId + requestSha256 match) and the run log would show status
    // "success". After the fix, the flag-ON branch rejects it for missing
    // signature fields before ever reaching the naive check, so the run log
    // must show "skipped" with a "declined" reason.
    const log = readLatestRunLog(home, plan.agent.id);
    expect(log.status).toBe('skipped');
    expect(log.errorMessage).toContain('declined');
  });

  it('rejects a reply with signature-like fields but an invalid signature when SIGNED_APPROVAL_ENABLED is true', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);

    const run = runExecutor([
      patchedExecutorPath,
      '--plan-file', planFile,
      '--home', home,
      '--agent-id', plan.agent.id,
      '--broker', brokerPath,
    ], home);

    const pending = await readNextActionRequest(home);
    const replyDir = path.join(home, '.shelly/agents/action-approval-replies');
    fs.mkdirSync(replyDir, { recursive: true });
    fs.writeFileSync(
      path.join(replyDir, `action-${pending.request.runId}.reply.json`),
      JSON.stringify({
        runId: pending.request.runId,
        decision: 'accept',
        by: 'human',
        requestSha256: pending.sha,
        nonce: pending.request.nonce,
        sigAlg: 'SHA256withRSA',
        signature: 'not-a-real-signature',
        keySha256: 'deadbeef',
        ts: new Date().toISOString(),
      }) + '\n',
    );

    await run;
    // Same reasoning as the sibling test above: the process exits 0 either
    // way, so the verdict must be read from the run log. This reply carries
    // signature-like fields but a garbage signature/keySha256 -- the fixed
    // code must verify (and reject) it via verifySignedApprovalReply rather
    // than accepting on shape alone.
    const log = readLatestRunLog(home, plan.agent.id);
    expect(log.status).toBe('skipped');
    expect(log.errorMessage).toContain('declined');
  });
});

// ─── Pure unit tests for the ported canonical/verify functions ───
//
// These call the executor's exports directly (no process spawn), mirroring
// __tests__/signed-approval/verify.test.ts's cases against the TS source, to
// prove the executor's plain-JS port has the same behavior as the policy it
// mirrors. SIGNED_APPROVAL_ENABLED remains false; these exports are inert in
// production and only reachable in tests / at a future flag-ON cutover.
describe('shelly-plan-executor signed-approval ported verifier (unit, pure)', () => {
  function makeRsaKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return { publicKey, privateKey, der };
  }

  function baseRequest(nonce: string) {
    const request: any = {
      runId: 'agent-x-100-42',
      agentId: 'agent-x',
      agentName: 'Agent X',
      toolLabel: 'codex',
      actionType: 'webhook',
      preview: 'POST to example.com',
      destinationHost: 'example.com',
      command: '',
      safetyLevel: 'ok',
      safetyReason: '',
      payloadPath: '',
      intentMode: '',
      intentTarget: '',
      intentShareText: '',
      dmPairingId: '',
      dmPairingLabel: '',
      dmReplyText: '',
      resultPath: '/x/result.txt',
      ts: '2026-07-03T00:00:00.000Z',
      expiresAt: Date.now() + 60_000,
      nonce,
    };
    request.requestSha256 = crypto.createHash('sha256').update(executor.canonicalApprovalRequest(request)).digest('hex');
    return request;
  }

  function signReply(privateKey: crypto.KeyObject, request: any, decision: string, overrides: any = {}) {
    const reply: any = {
      runId: request.runId,
      actionType: request.actionType,
      decision,
      by: 'human',
      ts: new Date().toISOString(),
      requestSha256: request.requestSha256,
      nonce: request.nonce,
      sigAlg: 'SHA256withRSA',
      keySha256: overrides.keySha256Override,
      ...overrides,
    };
    if (overrides.signature === undefined) {
      const message = executor.approvalReplySignatureMessage(reply);
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(message, 'utf8');
      signer.end();
      reply.signature = signer.sign(privateKey).toString('base64');
    }
    return reply;
  }

  function makeDeps(der: Buffer, expectedKeySha256: string, overrides: any = {}) {
    const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return {
      publicKey,
      publicKeySha256: expectedKeySha256,
      expectedKeySha256,
      allowedSigAlgs: executor.SIGNED_APPROVAL_ALLOWED_SIG_ALGS,
      nonceStore: executor.makeSignedApprovalNonceStore(),
      ...overrides,
    };
  }

  it('accepts a genuinely valid signed reply (ok:true)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-1');
    const reply = signReply(privateKey, request, 'accept', { keySha256Override: keySha256, keySha256 });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result).toEqual({ ok: true, reason: 'ok' });
  });

  it('rejects a tampered request field not reflected in requestSha256 (request-sha-mismatch)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-2');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    const tampered = { ...request, command: 'rm -rf /' };
    const result = executor.verifySignedApprovalReply(tampered, reply, makeDeps(der, keySha256));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('request-sha-mismatch');
  });

  it('rejects a reply bound to a different request hash (request-sha-mismatch)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-3');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    reply.requestSha256 = 'deadbeef';
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('request-sha-mismatch');
  });

  it('rejects a tampered signature (bad-signature)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-4');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    reply.signature = Buffer.from('not a real signature at all').toString('base64');
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects an expired request (expired)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-5');
    request.expiresAt = Date.now() - 1000;
    request.requestSha256 = crypto.createHash('sha256').update(executor.canonicalApprovalRequest(request)).digest('hex');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('expired');
  });

  it('rejects a reply whose claimed keySha256 does not match the pin (key-pin-mismatch)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-6');
    const reply = signReply(privateKey, request, 'accept', { keySha256: 'not-the-pinned-hash' });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('key-pin-mismatch');
  });

  it('rejects a reply actually signed with a different key, even if it CLAIMS the pinned keySha256 (bad-signature: the claimed hash is attacker-controlled, only the signature itself is load-bearing)', () => {
    const { der } = makeRsaKeyPair();
    const wrongKeyPair = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-6b');
    // Sign with a DIFFERENT key than the one pinned/loaded, but lie about keySha256.
    const reply = signReply(wrongKeyPair.privateKey, request, 'accept', { keySha256 });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('bad-signature');
  });

  it('fails closed when the pin itself is empty (key-pin-mismatch, vacuous pin is no pin)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-7');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, '' /* empty pin */));
    expect(result.reason).toBe('key-pin-mismatch');
  });

  it('rejects a replayed nonce on the second verify against a shared nonce store (nonce-replay)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-8');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    const deps = makeDeps(der, keySha256);
    expect(executor.verifySignedApprovalReply(request, reply, deps).ok).toBe(true);
    expect(executor.verifySignedApprovalReply(request, reply, deps).reason).toBe('nonce-replay');
  });

  it('rejects a substituted signature algorithm before verification is even attempted (bad-sig-alg, algorithm-confusion defense)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-9');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    reply.sigAlg = 'RSA-SHA256'; // node's createVerify name, NOT the allowed 'SHA256withRSA'
    // Also corrupt the signature bytes so that IF verify() were reached (it must
    // not be) it would still fail; this isolates that bad-sig-alg is returned
    // strictly from the allowlist check, before any crypto.createVerify call.
    reply.signature = 'AAAA';
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-sig-alg');
  });

  it('does not consume the nonce when an earlier check fails (a forged reply cannot burn a valid nonce)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-10');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    const deps = makeDeps(der, keySha256);
    const forged = { ...reply, signature: 'AAAA' };
    expect(executor.verifySignedApprovalReply(request, forged, deps).reason).toBe('bad-signature');
    // The genuine reply must still verify (nonce was not consumed by the forgery).
    expect(executor.verifySignedApprovalReply(request, reply, deps).ok).toBe(true);
  });

  it('rejects a non-human author (bad-author)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-11');
    const reply = signReply(privateKey, request, 'accept', { keySha256, by: 'agent' });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('bad-author');
  });

  it('rejects an invalid decision (bad-decision)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-12');
    const reply = signReply(privateKey, request, 'accept', { keySha256, decision: 'maybe' });
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('bad-decision');
  });

  it('rejects a nonce that does not match the request (nonce-mismatch)', () => {
    const { privateKey, der } = makeRsaKeyPair();
    const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
    const request = baseRequest('nonce-13');
    const reply = signReply(privateKey, request, 'accept', { keySha256 });
    reply.nonce = 'some-other-nonce';
    const result = executor.verifySignedApprovalReply(request, reply, makeDeps(der, keySha256));
    expect(result.reason).toBe('nonce-mismatch');
  });

  describe('ensureSignedApprovalVerifierKey (fail-closed DER key loading)', () => {
    function tmpKeyFile(der: Buffer): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-signed-approval-key-'));
      const file = path.join(dir, 'key.der');
      fs.writeFileSync(file, der);
      return file;
    }

    it('loads and caches a correctly-pinned key', () => {
      const { der } = makeRsaKeyPair();
      const keyPath = tmpKeyFile(der);
      const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
      const config: any = { signedApprovalPublicKeyPath: keyPath, signedApprovalPublicKeySha256: keySha256 };
      const events: any[] = [];
      executor.ensureSignedApprovalVerifierKey(config, (event: string, fields: any) => events.push({ event, fields }));
      expect(config.signedApprovalVerifierPublicKey).not.toBeNull();
      expect(events).toEqual([]);
    });

    it('fails closed (null key) when the pin does not match the actual file hash', () => {
      const { der } = makeRsaKeyPair();
      const keyPath = tmpKeyFile(der);
      const config: any = { signedApprovalPublicKeyPath: keyPath, signedApprovalPublicKeySha256: 'not-the-real-hash' };
      const events: any[] = [];
      executor.ensureSignedApprovalVerifierKey(config, (event: string, fields: any) => events.push({ event, fields }));
      expect(config.signedApprovalVerifierPublicKey).toBeNull();
      expect(events[0].event).toBe('signed_approval_verifier_key_untrusted');
    });

    it('fails closed (null key) when no pin is configured and unpinned keys are not explicitly allowed', () => {
      const { der } = makeRsaKeyPair();
      const keyPath = tmpKeyFile(der);
      const config: any = { signedApprovalPublicKeyPath: keyPath, signedApprovalPublicKeySha256: '' };
      const events: any[] = [];
      executor.ensureSignedApprovalVerifierKey(config, (event: string, fields: any) => events.push({ event, fields }));
      expect(config.signedApprovalVerifierPublicKey).toBeNull();
      expect(events[0].event).toBe('signed_approval_verifier_key_unpinned_refused');
    });

    it('fails closed (null key) when the file cannot be read', () => {
      const config: any = { signedApprovalPublicKeyPath: path.join(os.tmpdir(), 'does-not-exist.der'), signedApprovalPublicKeySha256: 'irrelevant' };
      const events: any[] = [];
      executor.ensureSignedApprovalVerifierKey(config, (event: string, fields: any) => events.push({ event, fields }));
      expect(config.signedApprovalVerifierPublicKey).toBeNull();
      expect(events[0].event).toBe('signed_approval_verifier_key_unavailable');
    });

    it('loads unpinned when explicitly allowed (host/dev escape hatch, audited)', () => {
      const { der } = makeRsaKeyPair();
      const keyPath = tmpKeyFile(der);
      const config: any = {
        signedApprovalPublicKeyPath: keyPath,
        signedApprovalPublicKeySha256: '',
        allowUnpinnedSignedApprovalVerifierKey: true,
      };
      const events: any[] = [];
      executor.ensureSignedApprovalVerifierKey(config, (event: string, fields: any) => events.push({ event, fields }));
      expect(config.signedApprovalVerifierPublicKey).not.toBeNull();
      expect(events[0].event).toBe('signed_approval_verifier_key_unpinned');
    });

    it('is idempotent: only loads once per config object', () => {
      const { der } = makeRsaKeyPair();
      const keyPath = tmpKeyFile(der);
      const keySha256 = crypto.createHash('sha256').update(der).digest('hex');
      const config: any = { signedApprovalPublicKeyPath: keyPath, signedApprovalPublicKeySha256: keySha256 };
      const events: any[] = [];
      const audit = (event: string, fields: any) => events.push({ event, fields });
      executor.ensureSignedApprovalVerifierKey(config, audit);
      const firstKey = config.signedApprovalVerifierPublicKey;
      fs.unlinkSync(keyPath); // key file gone; a second load attempt would now fail
      executor.ensureSignedApprovalVerifierKey(config, audit);
      expect(config.signedApprovalVerifierPublicKey).toBe(firstKey); // unchanged, not re-loaded
      expect(events).toEqual([]);
    });
  });

  describe('canonicalApprovalRequest / approvalReplySignatureMessage (canonical encoding)', () => {
    it('produces different hashes for requests differing only in one field', () => {
      const a = baseRequest('nonce-a');
      const b = { ...a, command: 'rm -rf /' };
      expect(executor.canonicalApprovalRequest(a)).not.toBe(executor.canonicalApprovalRequest(b));
    });

    it('encodes as a JSON array with the documented version tag', () => {
      const request = baseRequest('nonce-b');
      const encoded = JSON.parse(executor.canonicalApprovalRequest(request));
      expect(encoded[0]).toBe('shelly-agent-action-approval-request-v2');
      expect(Array.isArray(encoded)).toBe(true);
    });

    it('binds the current intent and dm-reply review fields', () => {
      const base = baseRequest('nonce-current-review');
      expect(executor.canonicalApprovalRequest({ ...base, actionType: 'intent', intentTarget: 'https://example.com' }))
        .not.toBe(executor.canonicalApprovalRequest(base));
      expect(executor.canonicalApprovalRequest({ ...base, actionType: 'dm-reply', dmReplyText: 'approved reply' }))
        .not.toBe(executor.canonicalApprovalRequest(base));
    });

    it('reply message uses its own version tag, distinct from the request tag', () => {
      const message = executor.approvalReplySignatureMessage({
        runId: 'r',
        actionType: 'draft',
        decision: 'accept',
        ts: 't',
        requestSha256: 'sha',
        nonce: 'n',
      });
      const encoded = JSON.parse(message);
      expect(encoded[0]).toBe('shelly-agent-action-approval-v2');
    });
  });

  describe('makeSignedApprovalNonceStore', () => {
    it('is single-use: true the first time, false on replay', () => {
      const store = executor.makeSignedApprovalNonceStore();
      expect(store.consume('abc')).toBe(true);
      expect(store.consume('abc')).toBe(false);
    });

    it('rejects an empty nonce', () => {
      const store = executor.makeSignedApprovalNonceStore();
      expect(store.consume('')).toBe(false);
    });
  });
});
