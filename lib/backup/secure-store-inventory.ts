/**
 * lib/backup/secure-store-inventory.ts — every expo-secure-store key Shelly
 * writes. SecureStore has no "list all keys" API, so backup/restore works
 * from this explicit inventory. __tests__/backup-inventory-drift.test.ts greps
 * the source tree for SecureStore usages and fails when a key is missing here.
 *
 * Restore decisions (read each owning module before changing):
 *
 *  - API keys (`shelly_<ApiKeyName>`), social-connector secrets, GitHub /
 *    dotfiles PATs: plain user credentials → restored.
 *  - `shelly_memory_v2_dek` (lib/memory/encryption-key.ts): the AES key for
 *    encrypted memory records under ~/.shelly. MUST be restored, otherwise
 *    every restored memory record is unreadable. Restoring overwrites a DEK the
 *    new install may already have generated; records written by the new
 *    install before restore become unreadable — acceptable on a fresh install,
 *    and the app is restarted right after so no stale in-memory DEK is used.
 *  - `shelly_policy_trust_allow_keys` (agent-trust-allow-seal.ts) and
 *    `shelly_closepaw_preapprovals_v1` (agent-closepaw-preapproval.ts): sets of
 *    human-granted allow keys / pre-approval bindings (agentId + definition
 *    hash). They are NOT bound to device or install identity, the matching
 *    policy.json / agent JSON come back through the tar, and the bundle that
 *    carries them is passphrase-authenticated → restored, so the user does not
 *    have to re-grant every trust allow.
 *  - `shelly_policy_file_seal` (agent-policy-device.ts): a list of policy.json
 *    hashes. The RN copy alone is not device-bound, but its native mirror is
 *    HMAC'd with an AndroidKeyStore key that does NOT survive reinstall. We
 *    restore it through the same write path as the app (SecureStore AND
 *    TerminalEmulator.setAgentPolicySeal, which re-HMACs with the NEW
 *    install's Keystore key) — see restorePolicySeal in service.ts. If the
 *    native bridge is missing, it is skipped (device-bound) and executors fail
 *    closed on a non-empty policy.json until the user re-saves the policy.
 *
 * Nothing here is skipped unconditionally today; DEVICE_BOUND_KEYS lists keys
 * whose restore needs the native re-seal path.
 */
import { API_KEY_NAMES } from '@/lib/secure-store';
import { SOCIAL_ALL_FIELDS, SOCIAL_PLATFORM_FIELDS, isSafeConnectorField, isSafeConnectorId } from '@/lib/social-connectors';

export const SECURE_KEY_PREFIX = 'shelly_';

/** Legacy names from older builds (lib/secure-store.ts LEGACY_SECRET_NAMES).
 *  Deliberately NOT backed up: deleteLegacySecrets() wipes them on launch. */
export const LEGACY_SECURE_KEYS: readonly string[] = Object.freeze([
  'shelly_claudeAuthToken',
  'shelly_geminiAuthToken',
]);

/** Fixed (non-dynamic) keys with their owning module. */
export const FIXED_SECURE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  shelly_closepaw_preapprovals_v1: 'lib/agent-closepaw-preapproval.ts',
  shelly_policy_file_seal: 'lib/agent-policy-device.ts',
  shelly_policy_trust_allow_keys: 'lib/agent-trust-allow-seal.ts',
  shelly_dotfiles_pat: 'lib/dotfiles-sync.ts',
  shelly_github_pat: 'lib/github-auth.ts',
  shelly_memory_v2_dek: 'lib/memory/encryption-key.ts',
});

/** Restored only via the native re-seal path (see module doc). */
export const POLICY_SEAL_KEY = 'shelly_policy_file_seal';
export const DEVICE_BOUND_KEYS: readonly string[] = Object.freeze([POLICY_SEAL_KEY]);

/** Fixed connector ids that are not user-registered social connectors. */
export const SYSTEM_CONNECTOR_SECRETS: ReadonlyArray<{ id: string; field: string; owner: string }> = Object.freeze([
  { id: 'mcp-server', field: 'token', owner: 'hooks/use-mcp-server-bridge.ts' },
]);

export function apiKeySecureKey(name: string): string {
  return `${SECURE_KEY_PREFIX}${name}`;
}

export function connectorSecureKey(id: string, field: string): string {
  return `${SECURE_KEY_PREFIX}social-connector.${id}.${field}`;
}

export type ConnectorRef = { id: string; platform?: string; fields?: string[] };

/** Parse AsyncStorage 'shelly_social_connectors' (settings-store). */
export function connectorsFromAsyncStorage(raw: string | null | undefined): ConnectorRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.id === 'string' && isSafeConnectorId(c.id))
      .map((c) => ({
        id: c.id,
        platform: typeof c.platform === 'string' ? c.platform : undefined,
        fields: Array.isArray(c.fields) ? c.fields.filter((f: unknown): f is string => typeof f === 'string') : undefined,
      }));
  } catch {
    return [];
  }
}

/** Every SecureStore key to try when backing up, given the registered
 *  social connectors. Missing keys simply read as null and are skipped. */
export function buildSecureStoreInventory(connectors: ConnectorRef[]): string[] {
  const keys = new Set<string>();
  for (const name of API_KEY_NAMES) keys.add(apiKeySecureKey(name));
  for (const k of Object.keys(FIXED_SECURE_KEYS)) keys.add(k);
  for (const s of SYSTEM_CONNECTOR_SECRETS) keys.add(connectorSecureKey(s.id, s.field));
  for (const c of connectors) {
    const platformFields =
      c.platform && c.platform in SOCIAL_PLATFORM_FIELDS
        ? (SOCIAL_PLATFORM_FIELDS as Record<string, readonly string[]>)[c.platform]
        : SOCIAL_ALL_FIELDS;
    const fields = new Set<string>([...(c.fields ?? []), ...platformFields]);
    for (const f of fields) {
      if (isSafeConnectorField(f)) keys.add(connectorSecureKey(c.id, f));
    }
  }
  return [...keys];
}

/** Restore-side allowlist: a decrypted bundle may only write keys of a shape
 *  Shelly itself uses (defence in depth against a crafted bundle). */
export function isRestorableSecureKey(key: string): boolean {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(key)) return false;
  if ((API_KEY_NAMES as readonly string[]).some((n) => apiKeySecureKey(n) === key)) return true;
  if (Object.prototype.hasOwnProperty.call(FIXED_SECURE_KEYS, key)) return true;
  const m = /^shelly_social-connector\.([^.]+)\.([^.]+)$/.exec(key);
  if (m && isSafeConnectorId(m[1]) && isSafeConnectorField(m[2])) return true;
  return false;
}

/** Display name for the restore summary (never the value). */
export function secureKeyDisplayName(key: string): string {
  const m = /^shelly_social-connector\.([^.]+)\.([^.]+)$/.exec(key);
  if (m) return `connector ${m[1]} (${m[2]})`;
  return key.startsWith(SECURE_KEY_PREFIX) ? key.slice(SECURE_KEY_PREFIX.length) : key;
}
