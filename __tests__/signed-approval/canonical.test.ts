import {
  APPROVAL_REPLY_MESSAGE_TAG,
  approvalReplySignatureMessage,
  canonicalRequest,
} from '@/lib/signed-approval/canonical';
import { ApprovalRequest } from '@/lib/signed-approval';

const replyFields = {
  runId: 'ag-100-42',
  actionType: 'webhook',
  decision: 'accept',
  ts: '2026-07-03T00:00:00.000Z',
  requestSha256: 'abc123',
  nonce: 'nonce-1',
};

function req(over: Partial<Omit<ApprovalRequest, 'requestSha256'>> = {}): Omit<ApprovalRequest, 'requestSha256'> {
  return {
    runId: 'ag-1',
    agentId: 'ag',
    agentName: 'Agent',
    toolLabel: 'codex',
    actionType: 'webhook',
    preview: 'P',
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
    ts: '2026-07-03T00:00:00Z',
    expiresAt: 1000,
    nonce: 'n1',
    ...over,
  };
}

describe('署名付き承認 canonical messages', () => {
  it('reply message is a version-tagged JSON array in fixed field order', () => {
    const msg = approvalReplySignatureMessage(replyFields);
    expect(JSON.parse(msg)).toEqual([
      APPROVAL_REPLY_MESSAGE_TAG,
      'ag-100-42',
      'webhook',
      'accept',
      '2026-07-03T00:00:00.000Z',
      'abc123',
      'nonce-1',
    ]);
  });

  it('reply message is injective: changing any signed field changes the message', () => {
    const base = approvalReplySignatureMessage(replyFields);
    expect(approvalReplySignatureMessage({ ...replyFields, decision: 'decline' })).not.toBe(base);
    expect(approvalReplySignatureMessage({ ...replyFields, nonce: 'nonce-2' })).not.toBe(base);
    expect(approvalReplySignatureMessage({ ...replyFields, requestSha256: 'zzz' })).not.toBe(base);
  });

  it('canonicalRequest is deterministic and version-tagged', () => {
    const a = canonicalRequest(req());
    expect(a).toBe(canonicalRequest(req()));
    expect(JSON.parse(a)[0]).toBe('shelly-agent-action-approval-request-v2');
    expect(canonicalRequest(req({ command: 'rm -rf /' }))).not.toBe(a);
  });

  it('resists newline delimiter injection (no cross-field collision)', () => {
    // The classic attack on a raw "\n"-join: move a newline across a field
    // boundary so two DIFFERENT field vectors produce the same canonical string.
    // A: preview="P",  destinationHost="\nevil.com"
    // B: preview="P\n", destinationHost="evil.com"
    // Under a naive '\n' join these collide; the JSON encoding must NOT.
    const a = canonicalRequest(req({ preview: 'P', destinationHost: '\nevil.com' }));
    const b = canonicalRequest(req({ preview: 'P\n', destinationHost: 'evil.com' }));
    expect(a).not.toBe(b);
  });

  it('binds the current intent and dm-reply review fields', () => {
    const base = canonicalRequest(req());
    expect(canonicalRequest(req({ actionType: 'intent', intentTarget: 'https://example.com' }))).not.toBe(base);
    expect(canonicalRequest(req({ actionType: 'intent', intentShareText: 'secret draft' }))).not.toBe(base);
    expect(canonicalRequest(req({ actionType: 'dm-reply', dmPairingId: 'pair-2' }))).not.toBe(base);
    expect(canonicalRequest(req({ actionType: 'dm-reply', dmReplyText: 'approved reply' }))).not.toBe(base);
  });
});
