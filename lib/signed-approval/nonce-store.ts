// 署名付き承認 — single-use nonce ledger.
//
// In-memory single-use nonce store for host tests and any ephemeral use. On
// device the ledger is durable (mirrors AgentEscalationBridge.registerActionNonce
// which single-use-removes a SecureRandom nonce), but the single-use SEMANTICS
// are the same and are what the verification policy relies on for replay defense.

import { NonceStore } from './types';

export class InMemoryNonceStore implements NonceStore {
  private used = new Set<string>();

  // True the first time a nonce is seen (records it); false on every replay.
  consume(nonce: string): boolean {
    if (!nonce || this.used.has(nonce)) return false;
    this.used.add(nonce);
    return true;
  }
}
