import { SIGNED_APPROVAL_ENABLED } from '@/lib/signed-approval';
import { KeystoreSigner } from '@/lib/signed-approval/signer-keystore';
import { NodeCryptoVerifier } from '@/lib/signed-approval/verifier-node';

describe('署名付き承認 dormancy + deferred adapters', () => {
  it('ships disabled', () => {
    expect(SIGNED_APPROVAL_ENABLED).toBe(false);
  });

  it('the deferred Keystore signer refuses until the cutover', () => {
    const signer = new KeystoreSigner();
    expect(() => signer.sign('msg')).toThrow(/deferred/);
    expect(() => signer.publicKeySha256()).toThrow(/deferred/);
  });

  it('the deferred node:crypto verifier refuses until the cutover', () => {
    const verifier = new NodeCryptoVerifier({ publicKeyPem: '-----BEGIN PUBLIC KEY-----' });
    expect(() => verifier.verify('msg', 'sig', 'RSA-SHA256')).toThrow(/deferred/);
    expect(() => verifier.publicKeySha256()).toThrow(/deferred/);
  });
});
