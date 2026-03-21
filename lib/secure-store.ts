/**
 * Secure API key storage using expo-secure-store.
 *
 * API keys are stored separately from AsyncStorage settings
 * to avoid plaintext exposure in app backup/debug dumps.
 */

import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'shelly_';

/** API key names that should be stored securely */
export const API_KEY_NAMES = ['geminiApiKey', 'perplexityApiKey', 'groqApiKey', 'cerebrasApiKey'] as const;
export type ApiKeyName = typeof API_KEY_NAMES[number];

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
