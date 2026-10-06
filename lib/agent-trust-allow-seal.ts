/**
 * lib/agent-trust-allow-seal.ts — POLICY-001 (B) tamper seal for trust-ramp
 * allows.
 *
 * policy.json lives in the agents dir, which every agent process can reach
 * as the same Linux uid. The codex gate hard-denies direct writes to it, but
 * a human-approved command (or a cli action) could still rewrite it. Rules in
 * that file can only TIGHTEN, so forging them gains an attacker nothing — but
 * a forged trust ALLOW would make the RN choke point auto-accept a cli
 * command. So the set of allow keys the human actually granted in chat is
 * ALSO kept in the Android-Keystore-backed SecureStore, and an allow is only
 * honoured when it appears in both places. A file-only allow is ignored
 * (fail-closed); revoking from chat updates both.
 *
 * Device-only (expo-secure-store); host tests inject the seal functions.
 */
import * as SecureStore from 'expo-secure-store';
import { logWarn } from '@/lib/debug-logger';

const SEAL_KEY = 'shelly_policy_trust_allow_keys';
let sealed: ReadonlySet<string> | null = null;

/** Last loaded/written seal; null until loaded (⇒ no allow is honoured). */
export function getTrustAllowSeal(): ReadonlySet<string> | null {
  return sealed;
}

export async function loadTrustAllowSeal(): Promise<ReadonlySet<string>> {
  try {
    const raw = await SecureStore.getItemAsync(SEAL_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    sealed = new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch (e) {
    logWarn('Policy', 'trust-allow seal unreadable — honouring no trust allows', e);
    sealed = new Set();
  }
  return sealed;
}

async function writeTrustAllowSeal(keys: Iterable<string>): Promise<void> {
  const unique = [...new Set(keys)];
  await SecureStore.setItemAsync(SEAL_KEY, JSON.stringify(unique));
  sealed = new Set(unique);
}

/** Seal one key the human just granted in chat. Per-key on purpose: never
 *  "seal whatever policy.json currently lists". */
export async function addTrustAllowSeal(key: string): Promise<void> {
  const current = sealed ?? (await loadTrustAllowSeal());
  await writeTrustAllowSeal([...current, key]);
}

export async function removeTrustAllowSeal(key: string): Promise<void> {
  const current = sealed ?? (await loadTrustAllowSeal());
  await writeTrustAllowSeal([...current].filter((k) => k !== key));
}

/** The seal object lib/agent-policy-chat.ts's PolicyChatIO expects. */
export const trustAllowSeal = { add: addTrustAllowSeal, remove: removeTrustAllowSeal };
