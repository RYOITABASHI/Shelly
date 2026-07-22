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

// Mirrors store/types.ts AgentActionType (the gated action set; excludes the
// synthetic __suppressed__/unsupported). app-act joined that set on
// 2026-07-14 (store/types.ts:566) but this dormant parity restatement was
// last touched before app-act existed and was never widened to match --
// the same narrow-fix/sibling-call-site-untouched gap fixed in
// app/_layout.tsx's handleAgentActionConfirm (fececf5a2). Nothing here is
// wired into a production path yet (see module doc comment above), so this
// is a type-only correction with no runtime behavior change today.
// social-post joined the gated set on 2026-07-22 (store/types.ts) and is
// widened here immediately to avoid repeating the app-act drift described
// above. (api-call is still absent — it predates this edit and its approval
// surface is PlanSpec-executor-only; widening it is out of scope here.)
export type ApprovalActionType = 'draft' | 'notify' | 'webhook' | 'cli' | 'intent' | 'dm-reply' | 'app-act' | 'social-post';

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
