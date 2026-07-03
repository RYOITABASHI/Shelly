// Deterministic fake crypto for 署名付き承認 host tests: a real node sha256
// Hasher plus a shared-secret Signer/Verifier pair that genuinely round-trips
// and detects tampering (a changed message => a different signature). Not a real
// asymmetric scheme — that lives in the deferred Keystore/node:crypto adapters —
// but sufficient to exercise the pure verification policy. Lives under
// __tests__/support (not a *.test.ts) so jest never runs it and Metro never
// bundles it, while tsc still type-checks it.

import * as crypto from 'crypto';

import { Hasher, Signer, Verifier } from '@/lib/signed-approval/types';

export function makeNodeHasher(): Hasher {
  return {
    sha256Hex: (data: string) => crypto.createHash('sha256').update(data).digest('hex'),
  };
}

export interface FakeCrypto {
  signer: Signer;
  verifier: Verifier;
  hasher: Hasher;
  keySha: string;
}

export function makeFakeCrypto(secret = 'test-signing-key'): FakeCrypto {
  const hasher = makeNodeHasher();
  const keySha = hasher.sha256Hex(`pub:${secret}`);
  const sigFor = (message: string) =>
    Buffer.from(hasher.sha256Hex(`${message}||${secret}`), 'hex').toString('base64');

  const signer: Signer = {
    sign: (message: string) => ({ sigAlg: 'FAKE-SHA256', signature: sigFor(message) }),
    publicKeySha256: () => keySha,
  };
  const verifier: Verifier = {
    verify: (message: string, signature: string, sigAlg: string) =>
      sigAlg === 'FAKE-SHA256' && signature === sigFor(message),
    publicKeySha256: () => keySha,
  };
  return { signer, verifier, hasher, keySha };
}
