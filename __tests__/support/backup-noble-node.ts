// Host-only node:crypto stand-ins for the ESM-only @noble modules that
// lib/backup/crypto.ts lazily require()s (ts-jest cannot parse their ESM
// build). Real AES-256-GCM (with AAD) and real RFC 7914 scrypt — same
// algorithms, same byte layout (ciphertext || 16-byte tag) as @noble — so the
// container format is genuinely exercised. Used via:
//   jest.mock('@noble/ciphers/aes.js', () => require('./support/backup-noble-node').nobleAes);
//   jest.mock('@noble/hashes/scrypt.js', () => require('./support/backup-noble-node').nobleScrypt);

import * as crypto from 'crypto';

const TAG = 16;

export function nodeGcm(key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array) {
  return {
    encrypt(data: Uint8Array): Uint8Array {
      const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
      if (aad) c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(Buffer.from(data)), c.final()]);
      return new Uint8Array(Buffer.concat([ct, c.getAuthTag()]));
    },
    decrypt(data: Uint8Array): Uint8Array {
      if (data.length < TAG) throw new Error('too short');
      const buf = Buffer.from(data);
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
      if (aad) d.setAAD(Buffer.from(aad));
      d.setAuthTag(buf.subarray(buf.length - TAG));
      return new Uint8Array(Buffer.concat([d.update(buf.subarray(0, buf.length - TAG)), d.final()]));
    },
  };
}

export const scryptCalls: Array<{ N: number; r: number; p: number }> = [];

export async function nodeScryptAsync(
  password: Uint8Array,
  salt: Uint8Array,
  opts: { N: number; r: number; p: number; dkLen: number; maxmem?: number; onProgress?: (f: number) => void },
): Promise<Uint8Array> {
  scryptCalls.push({ N: opts.N, r: opts.r, p: opts.p });
  opts.onProgress?.(0.5);
  const out = crypto.scryptSync(Buffer.from(password), Buffer.from(salt), opts.dkLen, {
    N: opts.N,
    r: opts.r,
    p: opts.p,
    maxmem: opts.maxmem ?? 256 * 1024 * 1024,
  });
  opts.onProgress?.(1);
  return new Uint8Array(out);
}

export const nobleAes = { gcm: nodeGcm };
export const nobleScrypt = { scryptAsync: nodeScryptAsync };

export async function nodeRandomBytes(n: number): Promise<Uint8Array> {
  return new Uint8Array(crypto.randomBytes(n));
}
