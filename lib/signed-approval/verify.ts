// 署名付き承認 — reply verification policy (the tamper-evidence core).
//
// Pure given its injected ports. Verifies that a signed reply genuinely
// authorizes THIS request: internal request integrity, request/reply binding,
// freshness, nonce binding + single-use (replay defense), public-key pinning,
// and the signature itself. Fail-closed: any failed check returns ok:false with
// a specific reason and never consumes the nonce (so a forged reply cannot burn
// a valid nonce). The nonce is consumed only as the final step, after the
// signature verifies — so a valid reply is single-use, an invalid one is inert.

import { approvalReplySignatureMessage, canonicalRequest } from './canonical';
import {
  ApprovalRequest,
  Clock,
  Hasher,
  NonceStore,
  SignedApprovalReply,
  Verifier,
  VerifyResult,
} from './types';

const VALID_DECISIONS = new Set(['accept', 'decline']);

export interface VerifyDeps {
  verifier: Verifier;
  clock: Clock;
  nonceStore: NonceStore;
  hasher: Hasher;
  // Pinned sha256 of the trusted signing public key. The verifier's key AND the
  // reply's claimed key must both match it (distribution channel: the existing
  // SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256 env pin). Must be non-empty.
  expectedKeySha256: string;
  // Allowlist of accepted signature algorithms — pins the algorithm so an
  // attacker cannot substitute a weaker one (Tier A hardcodes RSA-SHA256). The
  // reply's sigAlg must be a member before the signature is even verified.
  allowedSigAlgs: readonly string[];
  // Expected reply author (Tier A requires 'human'). Defaults to 'human'.
  expectedBy?: string;
}

export function verifyApprovalReply(
  request: ApprovalRequest,
  reply: SignedApprovalReply,
  deps: VerifyDeps,
): VerifyResult {
  const fail = (reason: VerifyResult['reason']): VerifyResult => ({ ok: false, reason });

  if (!VALID_DECISIONS.has(reply.decision)) return fail('bad-decision');
  if (reply.by !== (deps.expectedBy ?? 'human')) return fail('bad-author');
  // Pin the algorithm BEFORE verifying, so a weaker/attacker-chosen sigAlg can
  // never reach the verifier (algorithm-confusion defense).
  if (!deps.allowedSigAlgs.includes(reply.sigAlg)) return fail('bad-sig-alg');
  if (reply.runId !== request.runId) return fail('runid-mismatch');
  if (reply.actionType !== request.actionType) return fail('action-mismatch');

  // Recompute the request hash from its canonical form: proves the request is
  // internally consistent AND that the reply binds to this exact request.
  const expectedRequestSha = deps.hasher.sha256Hex(canonicalRequest(request));
  if (request.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');
  if (reply.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');

  if (deps.clock.now() > request.expiresAt) return fail('expired');
  if (reply.nonce !== request.nonce) return fail('nonce-mismatch');

  // Fail closed if the pin itself is empty/unset (a vacuous pin is no pin). The
  // trusted verifier key is the load-bearing side; reply.keySha256 is attacker-
  // controlled and ANDed in, so it can only ever reject, never bypass.
  if (
    !deps.expectedKeySha256 ||
    deps.verifier.publicKeySha256() !== deps.expectedKeySha256 ||
    reply.keySha256 !== deps.expectedKeySha256
  ) {
    return fail('key-pin-mismatch');
  }

  const message = approvalReplySignatureMessage(reply);
  if (!deps.verifier.verify(message, reply.signature, reply.sigAlg)) return fail('bad-signature');

  // Single-use LAST: only a fully-valid reply consumes the nonce; a replay of an
  // already-consumed nonce fails here.
  if (!deps.nonceStore.consume(reply.nonce)) return fail('nonce-replay');

  return { ok: true, reason: 'ok' };
}
