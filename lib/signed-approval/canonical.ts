// 署名付き承認 — canonical signable messages.
//
// Pure, deterministic string builders. A version tag leads each message so it
// can't collide across message kinds. The fields are encoded as a JSON array
// (NOT newline-joined): JSON escapes embedded newlines/quotes, so the encoding is
// INJECTIVE — an attacker cannot shift content across a field boundary to forge a
// colliding request hash. This matches Tier A's actual binding, which hashes the
// serialized JSON bytes (shelly-agent-driver.js sha256Hex over the JSON string /
// shelly-plan-executor.js sha256File over the JSON file), not a raw '\n' join.
// Both signer and verifier must build the byte-identical string.

import { ApprovalRequest, SignedApprovalReply } from './types';

// JSON.stringify of a fixed-order array: deterministic (array order is stable,
// string escaping is deterministic) and injective (no field can inject the
// delimiter or a boundary).
function encodeFields(fields: (string | number)[]): string {
  return JSON.stringify(fields);
}

// Version tag for the signed action-approval reply message. Moves in lockstep
// with SIGNED_APPROVAL_SCHEMA_VERSION.
export const APPROVAL_REPLY_MESSAGE_TAG = 'shelly-agent-action-approval-v2';

// The message the human reply is signed over. Binds runId, action, decision,
// reply ts, the exact request (via requestSha256), and the single-use nonce, so
// a signature cannot be lifted onto a different request/action/decision.
export function approvalReplySignatureMessage(fields: {
  runId: string;
  actionType: string;
  decision: string;
  ts: string;
  requestSha256: string;
  nonce: string;
}): string {
  return encodeFields([
    APPROVAL_REPLY_MESSAGE_TAG,
    String(fields.runId),
    String(fields.actionType),
    String(fields.decision),
    String(fields.ts || ''),
    String(fields.requestSha256),
    String(fields.nonce),
  ]);
}

// Convenience: build the message from a full reply record.
export function messageForReply(reply: SignedApprovalReply): string {
  return approvalReplySignatureMessage(reply);
}

// The canonical request string that requestSha256 hashes over. Fixed field order
// (not JSON key order) so the hash is stable regardless of serializer. Every
// field that a verifier must be able to trust is included.
export function canonicalRequest(request: Omit<ApprovalRequest, 'requestSha256'>): string {
  return encodeFields([
    'shelly-agent-action-approval-request-v2',
    String(request.runId),
    String(request.agentId),
    String(request.agentName),
    String(request.toolLabel),
    String(request.actionType),
    String(request.preview),
    String(request.destinationHost || ''),
    String(request.command || ''),
    String(request.safetyLevel || ''),
    String(request.safetyReason || ''),
    String(request.payloadPath || ''),
    String(request.intentMode || ''),
    String(request.intentTarget || ''),
    String(request.intentShareText || ''),
    String(request.dmPairingId || ''),
    String(request.dmPairingLabel || ''),
    String(request.dmReplyText || ''),
    String(request.resultPath || ''),
    String(request.ts),
    String(request.expiresAt),
    String(request.nonce),
  ]);
}
