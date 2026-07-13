// 署名付き承認 — dormant wiring seam.
//
// Documents how the Tier B action-approval loop adopts signed replies WITHOUT
// enabling it. Implemented (canonical + sign + verify + nonce + tests) but wired
// into no production path: SIGNED_APPROVAL_ENABLED stays false, and the live
// requestActionApproval / AgentActionApprovalBridge.writeHumanReply loop is
// byte-preserved. "実装されるが有効化はされない."
//
// MIGRATION (deferred, flag-ON step, out of scope until the floor is verified):
//   1. AgentActionApprovalBridge.writeHumanReply signs the canonical approval
//      message via the Android Keystore path already used by
//      AgentEscalationBridge (optionally biometric-bound via LocalAuthentication,
//      not yet a dependency), emitting a SignedApprovalReply.
//   2. The PlanSpec executor's requestActionApproval accept-path calls
//      verifyApprovalReply (node:crypto verifier, pinned to
//      SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256) instead of the current
//      runId + requestSha256 equality check — closing the same-uid forgery gap.
//   3. This lets AgentRuntime.trustedPlanLaunch widen beyond local-only
//      draft/notify once "PlanSpec integrity is signed" (its own TODO), because a
//      cloud/webhook/cli action could then be gated by a verifiable human reply.
//   4. Nonce issuance moves to native SecureRandom + a durable single-use ledger
//      (AgentEscalationBridge.registerActionNonce already does exactly this).

// Master dormancy switch. Never flipped by this work.
export const SIGNED_APPROVAL_ENABLED = false;
