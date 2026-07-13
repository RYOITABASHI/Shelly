// 署名付き承認 — Android Keystore signer (DEFERRED).
//
// Interface-conformant skeleton. The real signer already exists natively:
// AgentEscalationBridge.kt signs with an Android Keystore RSA keypair
// (SHA256withRSA, alias shelly_agent_*). At the flag-ON cutover the human-reply
// writer (AgentActionApprovalBridge.writeHumanReply) signs the canonical approval
// message through that Keystore path (optionally biometric-bound via
// LocalAuthentication, which is not yet a dependency). This TS skeleton pulls NO
// native dependency at module load and is NOT re-exported from index.ts until the
// cutover — the RN layer never signs inline (no crypto dep).

import { Signer } from './types';

const NOT_WIRED =
  'KeystoreSigner is deferred until the 署名付き承認 flag-ON cutover (native Keystore signs)';

export class KeystoreSigner implements Signer {
  sign(_message: string): { sigAlg: string; signature: string } {
    throw new Error(NOT_WIRED);
  }
  publicKeySha256(): string {
    throw new Error(NOT_WIRED);
  }
}
