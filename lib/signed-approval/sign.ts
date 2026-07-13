// 署名付き承認 — request builder + reply signer (producer side).
//
// Pure given injected ports. buildApprovalRequest stamps the canonical
// requestSha256 (via the injected Hasher); signApprovalReply produces the signed
// human reply over the canonical message (via the injected Signer). On device the
// Signer is Android Keystore RSA-SHA256 (AgentEscalationBridge); in host tests it
// is a deterministic fake. Neither this module nor the router touches raw keys.

import { approvalReplySignatureMessage, canonicalRequest } from './canonical';
import {
  ApprovalDecision,
  ApprovalRequest,
  Clock,
  Hasher,
  SignedApprovalReply,
  Signer,
} from './types';

// Compute requestSha256 over the canonical request and return the complete
// ApprovalRequest. The caller supplies everything except the hash.
export function buildApprovalRequest(
  fields: Omit<ApprovalRequest, 'requestSha256'>,
  hasher: Hasher,
): ApprovalRequest {
  const requestSha256 = hasher.sha256Hex(canonicalRequest(fields));
  return { ...fields, requestSha256 };
}

export interface SignReplyDeps {
  signer: Signer;
  clock: Clock;
  by?: string; // default 'human'
}

// Sign a decision for a request, producing the tamper-evident reply. The signed
// message binds runId/action/decision/ts/requestSha256/nonce.
export function signApprovalReply(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  deps: SignReplyDeps,
): SignedApprovalReply {
  const ts = new Date(deps.clock.now()).toISOString();
  const message = approvalReplySignatureMessage({
    runId: request.runId,
    actionType: request.actionType,
    decision,
    ts,
    requestSha256: request.requestSha256,
    nonce: request.nonce,
  });
  const { sigAlg, signature } = deps.signer.sign(message);
  return {
    runId: request.runId,
    actionType: request.actionType,
    decision,
    by: deps.by ?? 'human',
    ts,
    requestSha256: request.requestSha256,
    nonce: request.nonce,
    sigAlg,
    signature,
    keySha256: deps.signer.publicKeySha256(),
  };
}
