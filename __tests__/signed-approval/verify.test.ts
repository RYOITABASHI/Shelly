import { buildApprovalRequest, signApprovalReply } from '@/lib/signed-approval/sign';
import { canonicalRequest } from '@/lib/signed-approval/canonical';
import { verifyApprovalReply, VerifyDeps } from '@/lib/signed-approval/verify';
import { InMemoryNonceStore } from '@/lib/signed-approval/nonce-store';
import { ApprovalRequest, SignedApprovalReply } from '@/lib/signed-approval';
import { FakeClock } from '../support/event-queue-harness';
import { makeFakeCrypto } from '../support/signed-approval-crypto';

function setup() {
  const fx = makeFakeCrypto();
  const req: ApprovalRequest = buildApprovalRequest(
    {
      runId: 'ag-100-42',
      agentId: 'ag',
      agentName: 'Agent',
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
      expiresAt: 10_000,
      nonce: 'nonce-1',
    },
    fx.hasher,
  );
  const reply = signApprovalReply(req, 'accept', { signer: fx.signer, clock: new FakeClock(1000) });
  const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
    verifier: fx.verifier,
    clock: new FakeClock(2000),
    nonceStore: new InMemoryNonceStore(),
    hasher: fx.hasher,
    expectedKeySha256: fx.keySha,
    allowedSigAlgs: ['FAKE-SHA256'],
    ...over,
  });
  return { fx, req, reply, deps };
}

describe('署名付き承認 verification policy (fail-closed)', () => {
  it('rejects an invalid decision', () => {
    const { req, reply, deps } = setup();
    const bad: SignedApprovalReply = { ...reply, decision: 'maybe' as never };
    expect(verifyApprovalReply(req, bad, deps()).reason).toBe('bad-decision');
  });

  it('rejects a runId mismatch', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, runId: 'other' }, deps()).reason).toBe('runid-mismatch');
  });

  it('rejects an actionType mismatch', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, actionType: 'cli' }, deps()).reason).toBe('action-mismatch');
  });

  it('rejects a tampered request (recomputed sha differs)', () => {
    const { req, reply, deps } = setup();
    // Flip a request field without restamping requestSha256.
    const tampered: ApprovalRequest = { ...req, command: 'rm -rf /' };
    expect(verifyApprovalReply(tampered, reply, deps()).reason).toBe('request-sha-mismatch');
  });

  it('rejects a reply bound to a different request hash', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, requestSha256: 'deadbeef' }, deps()).reason).toBe(
      'request-sha-mismatch',
    );
  });

  it('rejects an expired request', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, reply, deps({ clock: new FakeClock(10_001) })).reason).toBe('expired');
  });

  it('rejects a nonce that does not match the request', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, nonce: 'nonce-2' }, deps()).reason).toBe('nonce-mismatch');
  });

  it('rejects when the verifier key does not match the pin', () => {
    const { req, reply, deps } = setup();
    const other = makeFakeCrypto('different-key');
    expect(verifyApprovalReply(req, reply, deps({ verifier: other.verifier })).reason).toBe('key-pin-mismatch');
  });

  it('rejects a tampered signature', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, signature: 'AAAA' }, deps()).reason).toBe('bad-signature');
  });

  it('rejects a decision flipped after signing (signature binds the decision)', () => {
    const { req, reply, deps } = setup();
    // decision is a valid value, but the signature was over 'accept'.
    expect(verifyApprovalReply(req, { ...reply, decision: 'decline' }, deps()).reason).toBe('bad-signature');
  });

  it('rejects a non-human author', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, by: 'agent' }, deps()).reason).toBe('bad-author');
  });

  it('rejects a substituted signature algorithm (algorithm-confusion defense)', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, sigAlg: 'MD5' }, deps()).reason).toBe('bad-sig-alg');
  });

  it('rejects a wrong reply.keySha256 even when the verifier key is correct', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, { ...reply, keySha256: 'not-the-pin' }, deps()).reason).toBe(
      'key-pin-mismatch',
    );
  });

  it('fails closed on an empty pin (a vacuous pin is no pin)', () => {
    const { req, reply, deps } = setup();
    expect(verifyApprovalReply(req, reply, deps({ expectedKeySha256: '' })).reason).toBe('key-pin-mismatch');
  });

  it('rejects an expiry-extension attempt (expiresAt is bound via requestSha256)', () => {
    const { fx, req, reply, deps } = setup();
    // Extend expiry AND restamp the request hash — reply.requestSha256 (signed)
    // still binds the original, so the recomputed hash no longer matches the reply.
    const extended = { ...req, expiresAt: req.expiresAt + 1_000_000 };
    extended.requestSha256 = fx.hasher.sha256Hex(canonicalRequest(extended));
    expect(verifyApprovalReply(extended, reply, deps({ clock: new FakeClock(req.expiresAt + 500_000) })).reason).toBe(
      'request-sha-mismatch',
    );
  });

  it('is single-use: the same valid reply cannot be replayed against a shared nonce store', () => {
    const { req, reply, deps } = setup();
    const shared = deps(); // one nonceStore reused across both calls
    expect(verifyApprovalReply(req, reply, shared).ok).toBe(true);
    expect(verifyApprovalReply(req, reply, shared).reason).toBe('nonce-replay');
  });

  it('does not consume the nonce when an earlier check fails (no DoS burn)', () => {
    const { fx, req, reply } = setup();
    const nonceStore = new InMemoryNonceStore();
    const d: VerifyDeps = {
      verifier: fx.verifier,
      clock: new FakeClock(2000),
      nonceStore,
      hasher: fx.hasher,
      expectedKeySha256: fx.keySha,
      allowedSigAlgs: ['FAKE-SHA256'],
    };
    // A forged (bad-signature) reply must NOT burn the nonce...
    expect(verifyApprovalReply(req, { ...reply, signature: 'AAAA' }, d).reason).toBe('bad-signature');
    // ...so the genuine reply still verifies.
    expect(verifyApprovalReply(req, reply, d).ok).toBe(true);
  });
});
