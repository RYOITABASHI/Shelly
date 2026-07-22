/**
 * Secure API key storage using expo-secure-store.
 *
 * API keys are stored separately from AsyncStorage settings
 * to avoid plaintext exposure in app backup/debug dumps.
 */

import * as SecureStore from 'expo-secure-store';
import { isSafeConnectorField, isSafeConnectorId, SOCIAL_ALL_FIELDS } from '@/lib/social-connectors';

const KEY_PREFIX = 'shelly_';

/** API key names that should be stored securely */
export const API_KEY_NAMES = [
  'geminiApiKey',
  'perplexityApiKey',
  'groqApiKey',
  'cerebrasApiKey',
  'codexAuthToken',
  // Phase 3 inbound gateway: the Telegram bot token is a secret → SecureStore.
  'telegramBotToken',
] as const;
export type ApiKeyName = typeof API_KEY_NAMES[number];

const LEGACY_SECRET_NAMES = [
  'claudeAuthToken',
  'geminiAuthToken',
] as const;

/**
 * Save an API key to secure storage.
 */
export async function saveApiKey(name: ApiKeyName, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(`${KEY_PREFIX}${name}`, value);
  } catch (e) {
    console.warn('[SecureStore] Failed to save key:', name, e);
  }
}

/**
 * Retrieve an API key from secure storage.
 */
export async function getApiKey(name: ApiKeyName): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(`${KEY_PREFIX}${name}`);
  } catch (e) {
    console.warn('[SecureStore] Failed to read key:', name, e);
    return null;
  }
}

/**
 * Delete an API key from secure storage.
 */
export async function deleteApiKey(name: ApiKeyName): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(`${KEY_PREFIX}${name}`);
  } catch (e) {
    console.warn('[SecureStore] Failed to delete key:', name, e);
  }
}

// ─── Social-connector secrets (2026-07-22) ──────────────────────────────────
// Generic per-(connectorId, field) secret storage for social auto-post
// connectors — mirrors the saveApiKey/getApiKey/deleteApiKey pattern above but
// keyed dynamically instead of by the fixed ApiKeyName enum. Key format:
// `shelly_social-connector.<id>.<field>` (expo-secure-store keys only allow
// [A-Za-z0-9._-], so the design doc's illustrative colons become dots).
// connectorId/field are validated (alphanumeric+hyphen / alphanumeric) so a
// crafted id can never break out of this key namespace.

function connectorSecretKey(connectorId: string, field: string): string {
  if (!isSafeConnectorId(connectorId)) {
    throw new Error(`refusing connector-secret access with unsafe connector id: ${connectorId}`);
  }
  if (!isSafeConnectorField(field)) {
    throw new Error(`refusing connector-secret access with unsafe field name: ${field}`);
  }
  return `${KEY_PREFIX}social-connector.${connectorId}.${field}`;
}

export async function saveConnectorSecret(connectorId: string, field: string, value: string): Promise<void> {
  const key = connectorSecretKey(connectorId, field);
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (e) {
    console.warn('[SecureStore] Failed to save connector secret:', connectorId, field, e);
  }
}

export async function getConnectorSecret(connectorId: string, field: string): Promise<string | null> {
  const key = connectorSecretKey(connectorId, field);
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e) {
    console.warn('[SecureStore] Failed to read connector secret:', connectorId, field, e);
    return null;
  }
}

export async function deleteConnectorSecret(connectorId: string, field: string): Promise<void> {
  const key = connectorSecretKey(connectorId, field);
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (e) {
    console.warn('[SecureStore] Failed to delete connector secret:', connectorId, field, e);
  }
}

/**
 * Delete every secret field of a connector (called on connector removal).
 * SecureStore has no key enumeration, so this deletes the connector's own
 * declared fields plus, as belt-and-braces, every known platform field name
 * (SOCIAL_ALL_FIELDS) — field sets are fixed per platform, so that union
 * covers anything ever written for this id.
 */
export async function deleteAllConnectorSecrets(connectorId: string, fields: string[] = []): Promise<void> {
  const all = new Set<string>([...fields, ...SOCIAL_ALL_FIELDS]);
  for (const field of all) {
    if (!isSafeConnectorField(field)) continue;
    await deleteConnectorSecret(connectorId, field);
  }
}

/**
 * Remove no-longer-used OAuth credentials from older Shelly builds.
 * These keys are intentionally excluded from API_KEY_NAMES so they cannot be
 * loaded back into settings, but old installs may still have them encrypted.
 */
export async function deleteLegacySecrets(): Promise<void> {
  for (const name of LEGACY_SECRET_NAMES) {
    try {
      await SecureStore.deleteItemAsync(`${KEY_PREFIX}${name}`);
    } catch (e) {
      console.warn('[SecureStore] Failed to delete legacy key:', name, e);
    }
  }
}

/**
 * Load all API keys from secure storage.
 * Returns a partial settings object with any found keys.
 */
export async function loadApiKeys(): Promise<Partial<Record<ApiKeyName, string>>> {
  const result: Partial<Record<ApiKeyName, string>> = {};
  for (const name of API_KEY_NAMES) {
    const value = await getApiKey(name);
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Check if a settings key is an API key that should be stored securely.
 */
export function isApiKeyField(key: string): key is ApiKeyName {
  return (API_KEY_NAMES as readonly string[]).includes(key);
}

/**
 * Strip API key fields from a settings object (for AsyncStorage).
 */
export function stripApiKeys<T extends Record<string, unknown>>(settings: T): T {
  const stripped = { ...settings };
  for (const name of API_KEY_NAMES) {
    delete stripped[name];
  }
  return stripped;
}
