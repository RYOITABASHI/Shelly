// 署名付き承認 — node:crypto verifier (DEFERRED).
//
// Interface-conformant skeleton. The real verifier already exists in the
// executor/driver layer: scripts/shelly-agent-driver.js verifies escalation
// replies with crypto.createVerify('RSA-SHA256') and pins to
// SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256. At the flag-ON cutover the PlanSpec
// executor verifies the signed approval reply the same way. This skeleton pulls
// NO node:crypto at module load (require happens lazily in the real impl, in the
// executor only) and is NOT re-exported from index.ts until the cutover.

import { Verifier } from './types';

const NOT_WIRED =
  'NodeCryptoVerifier is deferred until the 署名付き承認 flag-ON cutover (executor verifies via node:crypto)';

export interface NodeCryptoVerifierOptions {
  publicKeyPem: string;
}

export class NodeCryptoVerifier implements Verifier {
  constructor(_opts: NodeCryptoVerifierOptions) {
    // No crypto opened here — the executor-only impl requires node:crypto lazily.
  }
  verify(_message: string, _signature: string, _sigAlg: string): boolean {
    throw new Error(NOT_WIRED);
  }
  publicKeySha256(): string {
    throw new Error(NOT_WIRED);
  }
}
