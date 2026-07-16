// Host-only EncryptionPort backed by node:crypto's real AES-256-GCM, for
// exercising JsonFileMemoryStorage's Track A envelope-encryption path without
// expo-crypto/expo-secure-store/@noble/ciphers. Lives under __tests__/support
// (not a *.test.ts) so jest never runs it as a suite and Metro never bundles
// it into the app, while tsc still type-checks it. Never imported by
// production code — mirrors node-fs-port.ts's device-vs-host split for
// EncryptionPort the same way node-fs-port.ts does for FsPort.

import * as crypto from 'crypto';

import { EncryptedEnvelope, EncryptionPort } from '@/lib/memory/types';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * A real (not toy) AES-256-GCM EncryptionPort for host tests. Random key by
 * default so distinct test files/ports never accidentally share key material;
 * pass a fixed key to construct two ports that CAN decrypt each other's
 * envelopes (useful for "wrong key" negative tests).
 */
export function makeNodeEncryptionPort(key: Buffer = crypto.randomBytes(32)): EncryptionPort {
  return {
    async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
      const iv = crypto.randomBytes(GCM_IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        v: 1,
        iv: iv.toString('base64'),
        // Tag appended to the ciphertext, exactly like the production
        // @noble/ciphers gcm() cipher's output shape.
        ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
      };
    },
    async decrypt(envelope: EncryptedEnvelope): Promise<string> {
      const iv = Buffer.from(envelope.iv, 'base64');
      const combined = Buffer.from(envelope.ciphertext, 'base64');
      if (combined.length < GCM_TAG_BYTES) {
        throw new Error('envelope ciphertext too short to contain a GCM tag');
      }
      const tag = combined.subarray(combined.length - GCM_TAG_BYTES);
      const ciphertext = combined.subarray(0, combined.length - GCM_TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      // Throws on tag mismatch (tampered ciphertext / wrong key) — mirrors
      // @noble/ciphers' gcm().decrypt() throwing in the same situation.
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
