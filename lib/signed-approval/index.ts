// 署名付き承認 (SIGNED-APPROVAL) — public surface.
//
// Dormant Phase 1 primitive: tamper-evident, nonce-bound, single-use signed
// action approvals bringing the Tier B PlanSpec approval loop up to the Tier A
// escalation path's integrity. Flag-OFF (see wiring.ts); no production path
// imports it yet. The deferred Keystore signer / node:crypto verifier skeletons
// are intentionally NOT re-exported until the flag-ON cutover.

export * from './types';
export {
  APPROVAL_REPLY_MESSAGE_TAG,
  approvalReplySignatureMessage,
  messageForReply,
  canonicalRequest,
} from './canonical';
export { InMemoryNonceStore } from './nonce-store';
export { buildApprovalRequest, signApprovalReply } from './sign';
export type { SignReplyDeps } from './sign';
export { verifyApprovalReply } from './verify';
export type { VerifyDeps } from './verify';
export { SIGNED_APPROVAL_ENABLED } from './wiring';
