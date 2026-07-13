import { buildApprovalRequest, signApprovalReply } from '@/lib/signed-approval/sign';
import { verifyApprovalReply } from '@/lib/signed-approval/verify';
import { InMemoryNonceStore } from '@/lib/signed-approval/nonce-store';
import { ApprovalActionType, ApprovalRequest } from '@/lib/signed-approval';
import { FakeClock } from '../support/event-queue-harness';
import { makeFakeCrypto } from '../support/signed-approval-crypto';

function makeRequest(hasher: ReturnType<typeof makeFakeCrypto>['hasher'], over: Partial<ApprovalRequest> = {}) {
  return buildApprovalRequest(
    {
      runId: over.runId ?? 'ag-100-42',
      agentId: over.agentId ?? 'ag',
      agentName: 'Agent',
      toolLabel: 'codex',
      actionType: (over.actionType ?? 'webhook') as ApprovalActionType,
      preview: over.preview ?? 'POST to example.com',
      destinationHost: over.destinationHost ?? 'example.com',
      command: over.command ?? '',
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
      expiresAt: over.expiresAt ?? 10_000,
      nonce: over.nonce ?? 'nonce-1',
    },
    hasher,
  );
}

describe('署名付き承認 sign → verify round-trip', () => {
  it('accepts a well-formed signed accept reply', () => {
    const { signer, verifier, hasher, keySha } = makeFakeCrypto();
    const req = makeRequest(hasher);
    const reply = signApprovalReply(req, 'accept', { signer, clock: new FakeClock(1000) });
    const res = verifyApprovalReply(req, reply, {
      verifier,
      clock: new FakeClock(2000),
      nonceStore: new InMemoryNonceStore(),
      hasher,
      expectedKeySha256: keySha,
      allowedSigAlgs: ['FAKE-SHA256'],
    });
    expect(res).toEqual({ ok: true, reason: 'ok' });
    expect(reply.decision).toBe('accept');
    expect(reply.by).toBe('human');
    expect(reply.keySha256).toBe(keySha);
  });

  it('round-trips a decline reply too', () => {
    const { signer, verifier, hasher, keySha } = makeFakeCrypto();
    const req = makeRequest(hasher);
    const reply = signApprovalReply(req, 'decline', { signer, clock: new FakeClock(1000) });
    const res = verifyApprovalReply(req, reply, {
      verifier,
      clock: new FakeClock(1000),
      nonceStore: new InMemoryNonceStore(),
      hasher,
      expectedKeySha256: keySha,
      allowedSigAlgs: ['FAKE-SHA256'],
    });
    expect(res.ok).toBe(true);
    expect(reply.decision).toBe('decline');
  });

  it('stamps requestSha256 from the canonical request (bound to content)', () => {
    const { hasher } = makeFakeCrypto();
    const a = makeRequest(hasher, { command: '' });
    const b = makeRequest(hasher, { command: 'rm -rf /' });
    expect(a.requestSha256).not.toBe(b.requestSha256);
  });
});
