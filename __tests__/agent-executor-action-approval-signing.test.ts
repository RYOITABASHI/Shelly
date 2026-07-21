/**
 * docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー — 残課題 #1
 * (action approval reply の偽造可能性, P1/security).
 *
 * Threat this closes: wait_action_approval() (lib/agent-executor.ts) used to
 * trust an action-approval reply file on `runId` + `requestSha256` equality
 * alone. requestSha256 is a hash of a file the agent script ITSELF wrote, and
 * both the request and reply files live under the same uid the script runs
 * as — so the script could forge its own reply and bypass the human-approval
 * gate for its own configured action (cli/webhook/notify/etc).
 *
 * The fix mirrors the escalation-reply signing pattern already proven in
 * production (AgentEscalationBridge / Android Keystore RSA +
 * scripts/shelly-agent-driver.js's verifier): AgentActionApprovalBridge.kt
 * now signs every reply with a dedicated Keystore RSA key (whose private
 * material never leaves the keystore — same-uid file access does not confer
 * the ability to produce a valid signature), and a new
 * verify_action_approval_reply() bash helper (invoked from
 * wait_action_approval()) checks that signature via a bundled node verifier
 * before trusting a reply.
 *
 * These tests extract the REAL emitted verify_action_approval_reply() /
 * wait_action_approval() text out of generateRunScript()'s output (not a
 * hand-typed reimplementation) and execute it with a real bash + node child
 * process against a real RSA keypair, following this repo's established
 * "extractFunction + execute via bash -n / real execFileSync" convention
 * (see __tests__/agent-result-char-limit.test.ts, agent-executor-chain-
 * execution.test.ts's runChain()).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'sig-t',
    name: 'Sig Test',
    description: '',
    prompt: 'hi',
    schedule: null,
    tool: { type: 'local' } as ToolChoice,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: { type: 'draft' },
    ...overrides,
  } as Agent;
}

/** Mirrors __tests__/agent-result-char-limit.test.ts's extractFunction. */
function extractFunction(script: string, fnName: string): string {
  const marker = `${fnName}() {`;
  const fnStart = script.indexOf(marker);
  if (fnStart === -1) throw new Error(`${fnName} not found in generated script`);
  const lines = script.slice(fnStart).split('\n');
  let heredocTerm: string | null = null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredocTerm !== null) {
      if (line === heredocTerm) heredocTerm = null;
      continue;
    }
    const heredocMatch = line.match(/<<-?\s*'?"?([A-Z_]+)'?"?/);
    if (heredocMatch) {
      heredocTerm = heredocMatch[1];
      continue;
    }
    if (line === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`closing brace for ${fnName} not found`);
  return lines.slice(0, end + 1).join('\n');
}

const nodeBin = process.execPath.replace(/\\/g, '/');

/** Single-quote a value for embedding as a literal bash argument. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'action-approval-sig-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

describe('AGENT_SCRIPT_VERSION bump (docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1)', () => {
  it('generateRunScript emits SHELLY_AGENT_SCRIPT_VERSION>=17 (signing was introduced at v17)', () => {
    const s = generateRunScript(agent());
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=21');
  });

  it('AgentRuntime.kt CURRENT_SCRIPT_VERSION is bumped in lockstep (>=17, signing was introduced at v17)', () => {
    const kt = fs.readFileSync(
      path.resolve(
        __dirname,
        '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt',
      ),
      'utf8',
    );
    expect(kt).toContain('CURRENT_SCRIPT_VERSION = 21');
  });

  it('the full generated script still parses (bash -n)', () => {
    bashParses(generateRunScript(agent()));
  });
});

describe('verify_action_approval_reply — RSA signature verification', () => {
  let keyDir: string;
  let pubDerPath: string;
  let pubDerSha256: string;
  let privateKey: crypto.KeyObject;
  let otherPubDerPath: string;
  let otherPrivateKey: crypto.KeyObject;
  let verifyFn: string;

  beforeAll(() => {
    const s = generateRunScript(agent());
    verifyFn = extractFunction(s, 'verify_action_approval_reply');

    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-action-approval-sig-'));

    const pinned = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pinned.privateKey;
    const der = pinned.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    pubDerPath = path.join(keyDir, 'pub.der');
    fs.writeFileSync(pubDerPath, der);
    pubDerSha256 = crypto.createHash('sha256').update(der).digest('hex');

    // A completely separate, unpinned keypair — used to prove a reply signed
    // by ANY key other than the pinned one is rejected.
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    otherPrivateKey = other.privateKey;
    const otherDer = other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    otherPubDerPath = path.join(keyDir, 'other-pub.der');
    fs.writeFileSync(otherPubDerPath, otherDer);
  });

  afterAll(() => {
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  function signMessage(
    key: crypto.KeyObject,
    runId: string,
    decision: string,
    requestTs: string,
    requestSha256: string,
  ): string {
    const message = [runId, decision, requestTs, requestSha256].join('\n');
    return crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), key).toString('base64');
  }

  interface VerifyArgs {
    runId?: string;
    decision?: string;
    requestTs?: string;
    requestSha256?: string;
    sigAlg?: string;
    signature?: string;
    publicKeyFile?: string;
    publicKeySha256?: string;
  }

  function runVerify(args: VerifyArgs = {}): boolean {
    const runId = args.runId ?? 'agent-1-1700000000-123';
    const decision = args.decision ?? 'accept';
    const requestTs = args.requestTs ?? '2026-07-17T00:00:00.000Z';
    const requestSha256 = args.requestSha256 ?? 'a'.repeat(64);
    const sigAlg = args.sigAlg ?? 'SHA256withRSA';
    const signature =
      args.signature ?? signMessage(privateKey, runId, decision, requestTs, requestSha256);
    const publicKeyFile = args.publicKeyFile ?? pubDerPath;
    const publicKeySha256 = args.publicKeySha256 ?? pubDerSha256;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-verify-run-'));
    const scriptPath = path.join(dir, 'run.sh');
    const wrapper = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
ACTION_APPROVAL_PUBLIC_KEY_FILE=${sh(publicKeyFile)}
ACTION_APPROVAL_PUBLIC_KEY_SHA256=${sh(publicKeySha256)}
${verifyFn}
if verify_action_approval_reply ${sh(runId)} ${sh(decision)} ${sh(requestTs)} ${sh(requestSha256)} ${sh(sigAlg)} ${sh(signature)}; then
  echo VALID
else
  echo INVALID
fi
`;
    fs.writeFileSync(scriptPath, wrapper, 'utf8');
    try {
      const out = execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8').trim();
      return out === 'VALID';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // (a) a valid signed reply is accepted.
  it('accepts a valid accept reply signed by the pinned key', () => {
    expect(runVerify({ decision: 'accept' })).toBe(true);
  });

  it('accepts a valid decline reply signed by the pinned key (decision is bound into the message, not special-cased)', () => {
    expect(runVerify({ decision: 'decline' })).toBe(true);
  });

  // (b) a reply with no signature is rejected.
  it('rejects a reply with an empty signature', () => {
    expect(runVerify({ signature: '' })).toBe(false);
  });

  it('rejects a reply with an empty sigAlg', () => {
    expect(runVerify({ sigAlg: '' })).toBe(false);
  });

  it('rejects a reply with a non-RSA sigAlg', () => {
    expect(runVerify({ sigAlg: 'HMAC-SHA256' })).toBe(false);
  });

  // (c) a reply with an invalid/tampered signature is rejected.
  it('rejects a tampered (bit-flipped) signature', () => {
    const validSig = signMessage(privateKey, 'agent-1-1700000000-123', 'accept', '2026-07-17T00:00:00.000Z', 'a'.repeat(64));
    const sigBuf = Buffer.from(validSig, 'base64');
    sigBuf[0] ^= 0xff;
    expect(runVerify({ signature: sigBuf.toString('base64') })).toBe(false);
  });

  it('rejects a signature that is valid for a DIFFERENT requestSha256 (message binding)', () => {
    const runId = 'agent-1-1700000000-123';
    const decision = 'accept';
    const requestTs = '2026-07-17T00:00:00.000Z';
    const signedForOtherHash = signMessage(privateKey, runId, decision, requestTs, 'b'.repeat(64));
    expect(
      runVerify({ runId, decision, requestTs, requestSha256: 'a'.repeat(64), signature: signedForOtherHash }),
    ).toBe(false);
  });

  // (d) a reply signed with a DIFFERENT keypair (not the pinned one) is rejected.
  it('rejects a reply signed by a different (unpinned) keypair', () => {
    const runId = 'agent-1-1700000000-123';
    const decision = 'accept';
    const requestTs = '2026-07-17T00:00:00.000Z';
    const requestSha256 = 'a'.repeat(64);
    const forgedSignature = signMessage(otherPrivateKey, runId, decision, requestTs, requestSha256);
    // publicKeyFile/publicKeySha256 default to the PINNED key — the forged
    // signature was produced by a completely different private key.
    expect(runVerify({ runId, decision, requestTs, requestSha256, signature: forgedSignature })).toBe(false);
  });

  it('fails closed when the on-disk public key does not match the pinned sha256 (tamper-detect the pin itself)', () => {
    // Sign with the key that's genuinely ON DISK at otherPubDerPath, but keep
    // the PIN pointing at the original (pubDerSha256) key — simulates a
    // same-uid script overwriting the DER file with its own keypair.
    const runId = 'agent-1-1700000000-123';
    const decision = 'accept';
    const requestTs = '2026-07-17T00:00:00.000Z';
    const requestSha256 = 'a'.repeat(64);
    const signature = signMessage(otherPrivateKey, runId, decision, requestTs, requestSha256);
    expect(
      runVerify({
        runId,
        decision,
        requestTs,
        requestSha256,
        signature,
        publicKeyFile: otherPubDerPath,
        publicKeySha256: pubDerSha256,
      }),
    ).toBe(false);
  });

  it('fails closed when the pin (ACTION_APPROVAL_PUBLIC_KEY_SHA256) is empty (unpinned launcher)', () => {
    expect(runVerify({ publicKeySha256: '' })).toBe(false);
  });

  it('fails closed when the public key file is missing', () => {
    expect(runVerify({ publicKeyFile: path.join(keyDir, 'no-such-file.der') })).toBe(false);
  });

  it('rejects a decision that is neither accept nor decline', () => {
    expect(runVerify({ decision: 'maybe' })).toBe(false);
  });
});

describe('wait_action_approval — end-to-end reply-file verification', () => {
  let verifyFn: string;
  let jsonFieldFn: string;
  let waitFn: string;
  let pubDerPath: string;
  let pubDerSha256: string;
  let privateKey: crypto.KeyObject;
  let otherPrivateKey: crypto.KeyObject;
  let tmpRoot: string;

  beforeAll(() => {
    const s = generateRunScript(agent());
    verifyFn = extractFunction(s, 'verify_action_approval_reply');
    jsonFieldFn = extractFunction(s, 'json_field_file');
    waitFn = extractFunction(s, 'wait_action_approval');

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-wait-approval-'));
    const pinned = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pinned.privateKey;
    const der = pinned.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    pubDerPath = path.join(tmpRoot, 'pub.der');
    fs.writeFileSync(pubDerPath, der);
    pubDerSha256 = crypto.createHash('sha256').update(der).digest('hex');

    otherPrivateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function signMessage(
    key: crypto.KeyObject,
    runId: string,
    decision: string,
    requestTs: string,
    requestSha256: string,
  ): string {
    const message = [runId, decision, requestTs, requestSha256].join('\n');
    return crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), key).toString('base64');
  }

  function runWait(opts: {
    decision: 'accept' | 'decline';
    signWith?: crypto.KeyObject;
    signature?: string;
    sigAlg?: string;
    omitSignature?: boolean;
  }): { exitOk: boolean; status: string; message: string } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
    const runId = 'agent-x-1700000000-999';
    const requestTs = '2026-07-17T00:00:00.000Z';
    const requestSha256 = 'c'.repeat(64);
    const requestFile = path.join(dir, 'action-req.json');
    const replyFile = path.join(dir, 'action-reply.json');
    fs.writeFileSync(requestFile, JSON.stringify({ runId, ts: requestTs }));

    const reply: Record<string, unknown> = {
      runId,
      decision: opts.decision,
      by: 'human',
      requestSha256,
      requestTs,
    };
    if (!opts.omitSignature) {
      reply.sigAlg = opts.sigAlg ?? 'SHA256withRSA';
      reply.signature =
        opts.signature ?? signMessage(opts.signWith ?? privateKey, runId, opts.decision, requestTs, requestSha256);
    }
    fs.writeFileSync(replyFile, JSON.stringify(reply));

    const scriptPath = path.join(dir, 'run.sh');
    const wrapper = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
write_native_notification_request() { return 0; }
ACTION_RUN_ID=${sh(runId)}
ACTION_APPROVAL_REQUEST_SHA256=${sh(requestSha256)}
ACTION_APPROVAL_REQUEST_FILE=${sh(requestFile)}
ACTION_APPROVAL_REPLY_FILE=${sh(replyFile)}
ACTION_APPROVAL_PUBLIC_KEY_FILE=${sh(pubDerPath)}
ACTION_APPROVAL_PUBLIC_KEY_SHA256=${sh(pubDerSha256)}
ACTION_APPROVAL_TIMEOUT_SECONDS=5
ACTION_DISPATCH_STATUS=""
ACTION_DISPATCH_MESSAGE=""
${jsonFieldFn}
${verifyFn}
${waitFn}
if wait_action_approval "cli"; then
  echo EXIT_OK=1
else
  echo EXIT_OK=0
fi
echo "STATUS=$ACTION_DISPATCH_STATUS"
echo "MESSAGE=$ACTION_DISPATCH_MESSAGE"
`;
    fs.writeFileSync(scriptPath, wrapper, 'utf8');
    const out = execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8');
    const exitOk = /EXIT_OK=1/.test(out);
    const status = /STATUS=(\w*)/.exec(out)?.[1] ?? '';
    const messageMatch = /MESSAGE=(.*)/.exec(out);
    const message = messageMatch ? messageMatch[1] : '';
    return { exitOk, status, message };
  }

  // (a) a valid signed reply is accepted end-to-end.
  it('a validly-signed accept reply is trusted (returns success, no dispatch error)', () => {
    const result = runWait({ decision: 'accept' });
    expect(result.exitOk).toBe(true);
    expect(result.status).toBe('');
  });

  it('a validly-signed decline reply is honored as a decline (not an error)', () => {
    const result = runWait({ decision: 'decline' });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('declined');
  });

  // (b) a reply with no signature is rejected.
  it('an accept reply with no signature fields at all is rejected as an error, not honored as accept', () => {
    const result = runWait({ decision: 'accept', omitSignature: true });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('error');
    expect(result.message).toContain('signature could not be verified');
  });

  // (c) a reply with a tampered signature is rejected.
  it('an accept reply with a tampered signature is rejected as an error, not honored as accept', () => {
    const validSig = signMessage(privateKey, 'agent-x-1700000000-999', 'accept', '2026-07-17T00:00:00.000Z', 'c'.repeat(64));
    const sigBuf = Buffer.from(validSig, 'base64');
    sigBuf[0] ^= 0xff;
    const result = runWait({ decision: 'accept', signature: sigBuf.toString('base64') });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('error');
    expect(result.message).toContain('signature could not be verified');
  });

  // (d) a reply signed with a different keypair is rejected.
  it('an accept reply forged with a same-uid-writable but UNPINNED keypair is rejected, not silently honored — the exact forgery this fix closes', () => {
    const result = runWait({ decision: 'accept', signWith: otherPrivateKey });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('error');
    expect(result.message).toContain('signature could not be verified');
  });
});
