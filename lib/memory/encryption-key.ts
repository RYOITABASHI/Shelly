// MEMORY-001 memory layer — DEK (data-encryption-key) lifecycle for Track A
// envelope encryption (see DEFERRED.md MEMORY-001, 2026-07-16 plan).
//
// Lazily generates a 256-bit AES key on first use and stores it via
// expo-secure-store (Android Keystore-bound) under its OWN dedicated key
// name. This is DELIBERATE and must stay this way: the name below is NOT
// added to lib/secure-store.ts's API_KEY_NAMES, so it can never be returned
// by loadApiKeys(), never round-trips through settings-store, and never gets
// a row in the Settings > API Keys inline editor. It is an internal-only
// device secret, never user-visible, never a "key I typed in" — mixing it
// into the API-key surface would risk exposing/deleting it via ordinary
// settings UI flows that were designed for a completely different kind of
// secret.
//
// No rotation in Track A. A second key would need an envelope `keyId` (see
// types.ts EncryptedEnvelope) plus a re-encrypt migration of every existing
// record — both explicitly out of scope here (see the plan's Track A/B/C/D
// split). Uninstalling the app drops the Keystore entry and makes existing
// memory-v2 records permanently unreadable — the same accepted behavior as
// lib/secure-store.ts's API keys.
//
// Device-only: imports expo-secure-store + expo-crypto directly, exactly like
// fs-expo.ts imports expo-file-system directly. Host tests never load this
// file.

import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { base64ToBytes, bytesToBase64 } from './base64';

// Own constant, intentionally NOT part of lib/secure-store.ts's KEY_PREFIX /
// API_KEY_NAMES list. See module doc above.
const DEK_STORAGE_KEY = 'shelly_memory_v2_dek';
const DEK_BYTE_LENGTH = 32; // 256-bit AES-256-GCM key

// In-flight-generation memoization: two callers racing on the very first
// getMemoryDek() call (e.g. two records written back-to-back before the
// first SecureStore.setItemAsync resolves) must not each independently
// generate-and-write a different key, or the loser's write would silently
// make the winner's already-encrypted record unreadable. Memoizing the
// PROMISE (not just the resolved value) collapses concurrent callers onto a
// single generate-or-load in-flight operation.
let dekPromise: Promise<Uint8Array> | null = null;

async function loadOrCreateDek(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(DEK_STORAGE_KEY);
  if (existing) {
    return base64ToBytes(existing);
  }
  // CSPRNG only — Math.random is never acceptable for key material.
  const fresh = await getRandomBytesAsync(DEK_BYTE_LENGTH);
  await SecureStore.setItemAsync(DEK_STORAGE_KEY, bytesToBase64(fresh));
  return fresh;
}

/**
 * Returns the raw 256-bit memory-v2 DEK, generating and persisting one on
 * first call. Safe to call concurrently — all callers before the first
 * resolution share the same in-flight generate-or-load.
 */
export function getMemoryDek(): Promise<Uint8Array> {
  if (!dekPromise) {
    dekPromise = loadOrCreateDek().catch((err) => {
      // Don't cache a rejection forever — a transient SecureStore failure
      // should be retryable on the next call, not a permanent poison pill.
      dekPromise = null;
      throw err;
    });
  }
  return dekPromise;
}
