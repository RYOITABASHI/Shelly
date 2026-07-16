// MEMORY-001 memory layer — real on-device EncryptionPort (Track A envelope
// encryption; see DEFERRED.md MEMORY-001, 2026-07-16 plan).
//
// Fulfils the EncryptionPort contract from ./types using @noble/ciphers'
// pure-JS AES-256-GCM plus expo-crypto's CSPRNG for the per-record IV — the
// SAME device-only import pattern fs-expo.ts already uses for FsPort. Host
// tests never load this file (they inject a node:crypto-backed fake, see
// __tests__/support/node-encryption-port.ts); it only runs on device, and
// only when a MEMORY_ENABLED path (shadow.ts today) asks for a port. Dormant:
// "実装されるが有効化はされない."
//
// This module never touches expo-secure-store directly — encryption-key.ts
// owns the DEK lifecycle so there is exactly one place a Keystore-bound
// secret is read/written.

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import { getRandomBytesAsync } from 'expo-crypto';
import { base64ToBytes, bytesToBase64 } from './base64';
import { getMemoryDek } from './encryption-key';
import { EncryptedEnvelope, EncryptionPort } from './types';

const ENVELOPE_VERSION = 1;
// 96-bit nonce — the size @noble/ciphers' gcm() recommends and the NIST
// SP 800-38D default; every encrypt() call draws a fresh one from expo-crypto's
// CSPRNG (never Math.random, never reused — GCM security depends on a unique
// (key, iv) pair per message).
const GCM_IV_BYTES = 12;

export function createExpoEncryptionPort(): EncryptionPort {
  return {
    async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
      const key = await getMemoryDek();
      const iv = await getRandomBytesAsync(GCM_IV_BYTES);
      // gcm(key, iv) cipher instances are single-use by design (@noble/ciphers
      // ties the nonce to construction), so a fresh instance per call is
      // required, not just a style choice.
      const ciphertext = gcm(key, iv).encrypt(utf8ToBytes(plaintext));
      return {
        v: ENVELOPE_VERSION,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
      };
    },
    async decrypt(envelope: EncryptedEnvelope): Promise<string> {
      const key = await getMemoryDek();
      const iv = base64ToBytes(envelope.iv);
      const ciphertext = base64ToBytes(envelope.ciphertext);
      // Throws on auth-tag mismatch (tampered/corrupt/wrong-key ciphertext) —
      // storage-json.ts's readRecord() catches this and degrades to "absent",
      // never crashing the namespace load.
      const plaintext = gcm(key, iv).decrypt(ciphertext);
      return bytesToUtf8(plaintext);
    },
  };
}
