// 署名付き承認 (SIGNED-APPROVAL) — shared types and ports.
//
// Pure, dependency-free contract for tamper-evident action approvals. It brings
// the PlanSpec action-approval path (Tier B: today only sha256(request-bytes) +
// expiresAt + uid isolation — a same-uid process can forge a valid reply) up to
// the integrity already used by the escalation path (Tier A: Android Keystore
// RSA-SHA256, per-request single-use nonce, requestSha256 binding, public-key
// pinning). The canonical-message convention and the crypto primitive are taken
// verbatim from Tier A (scripts/shelly-agent-driver.js escalationSignatureMessage
// + AgentEscalationBridge.kt), so this is a PARITY restatement, not a new design.
//
// Dormant: nothing here is wired into a production path yet (see wiring.ts,
// SIGNED_APPROVAL_ENABLED). The live approval loop (requestActionApproval /
// AgentActionApprovalBridge.writeHumanReply) is byte-preserved.
// "実装されるが有効化はされない."
//
// The RN/app layer has no crypto dep (package.json), so sign/verify/hash are
// INJECTED ports. Real backends already exist: Android Keystore (native sign) and
// node:crypto RSA-SHA256 (executor verify). Host tests use a deterministic fake.

// Bump only alongside a canonical-message or record shape change. The canonical
// message carries its own version tag (see canonical.ts) which must move in
// lockstep; a native/executor consumer that verifies these records mirrors it.
export const SIGNED_APPROVAL_SCHEMA_VERSION = 2;

// Codex review (2026-08-29, Hermes Agent parity audit): this dormant type
// used to hand-restate the gated action set and had already drifted once
// (api-call missing, its own comment admitted as much and called widening
// "out of scope" -- exactly the kind of narrow-fix gap this project's own
// action-type schema drift has repeatedly produced in the LIVE approval
// path, see lib/agent-action-types.ts's doc comment for the history). Now
// re-exported from that single source of truth instead of restated, so this
// dormant type can never independently drift from the live schema again --
// __tests__/agent-action-type-schema-parity.test.ts asserts the identity.
import type { ApprovalActionType } from '@/lib/agent-action-types';
export type { ApprovalActionType } from '@/lib/agent-action-types';

export type ApprovalDecision = 'accept' | 'decline';

// Restates the action-approval request (AgentActionApprovalBridge.kt / the
// requestActionApproval builder), plus a per-request nonce for single-use.
export interface ApprovalRequest {
  runId: string;
  agentId: string;
  agentName: string;
  toolLabel: string;
  actionType: ApprovalActionType;
  preview: string;
  destinationHost: string;
  command: string;
  safetyLevel: string;
  safetyReason: string;
  payloadPath: string;
  intentMode: string;
  intentTarget: string;
  intentShareText: string;
  dmPairingId: string;
  dmPairingLabel: string;
  dmReplyText: string;
  resultPath: string;
  ts: string; // ISO-8601
  expiresAt: number; // epoch ms
  // Per-request single-use nonce (Tier A parity). Bound into the signed reply.
  nonce: string;
  // sha256 hex of the canonical request (canonical.ts), bound into the reply.
  requestSha256: string;
}

// The signed human reply. Adds sigAlg/signature/nonce over the Tier B reply.
export interface SignedApprovalReply {
  runId: string;
  actionType: ApprovalActionType;
  decision: ApprovalDecision;
  by: string; // 'human'
  ts: string; // ISO-8601 reply time
  requestSha256: string;
  nonce: string;
  sigAlg: string;
  signature: string; // base64
  // sha256 hex of the signing public key, for pin verification.
  keySha256: string;
}

// ── Injected ports (real backends exist in native/executor; fakes in host tests) ──

export interface Signer {
  sign(message: string): { sigAlg: string; signature: string };
  // sha256 hex of the signing public key (SPKI), for the verifier pin.
  publicKeySha256(): string;
}

export interface Verifier {
  verify(message: string, signature: string, sigAlg: string): boolean;
  publicKeySha256(): string;
}

export interface Clock {
  now(): number;
}

// Single-use nonce ledger. consume() returns true the FIRST time a nonce is
// seen (and records it), false on any replay — the tamper-evidence for replay.
export interface NonceStore {
  consume(nonce: string): boolean;
}

// Injected hash (RN has no crypto; node:crypto / Kotlin MessageDigest on device).
export interface Hasher {
  sha256Hex(data: string): string;
}

export type VerifyReason =
  | 'ok'
  | 'bad-decision'
  | 'bad-author'
  | 'bad-sig-alg'
  | 'runid-mismatch'
  | 'action-mismatch'
  | 'request-sha-mismatch'
  | 'expired'
  | 'nonce-mismatch'
  | 'nonce-replay'
  | 'key-pin-mismatch'
  | 'bad-signature';

export interface VerifyResult {
  ok: boolean;
  reason: VerifyReason;
}
