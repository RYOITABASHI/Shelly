/**
 * lib/pro.ts — Pro/Free feature gating
 *
 * Build-time: SHELLY_PRO env var → app.config.ts extra.shellyPro
 * Runtime: AsyncStorage override (future: license key, GitHub Sponsors)
 *
 * Pro features: API integrations (Groq, Perplexity, Gemini API),
 * Local LLM, MCP, @team Table, Obsidian, System Prompt
 */

import Constants from 'expo-constants';

/** Build-time Pro flag from app.config.ts extra.shellyPro */
const BUILD_PRO = Constants.expoConfig?.extra?.shellyPro === true;

/** GitHub Sponsors URL — single source of truth */
export const SPONSOR_URL = 'https://github.com/sponsors/RYOITABASHI';

/** Runtime override (set by unlockPro, loaded on startup) */
let runtimeOverride: boolean | null = null;

/**
 * Check if Pro features are enabled.
 * Runtime override takes precedence over build-time flag.
 */
export function isPro(): boolean {
  return runtimeOverride ?? BUILD_PRO;
}

/**
 * Load Pro status from persistent storage (called on app startup).
 * Future: check license key validity, GitHub Sponsors status, etc.
 */
export async function loadProStatus(): Promise<void> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const stored = await AsyncStorage.getItem('shelly_pro_unlocked');
    if (stored === 'true') {
      runtimeOverride = true;
    }
  } catch (e) {
    console.warn('[Pro] Failed to load Pro status:', e);
  }
}

/**
 * Unlock Pro features at runtime.
 * Future: validate license key before calling this.
 */
export async function unlockPro(): Promise<void> {
  runtimeOverride = true;
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await AsyncStorage.setItem('shelly_pro_unlocked', 'true');
  } catch {
    // Non-fatal
  }
}

/**
 * Lock Pro features (revert to build-time default).
 */
export async function lockPro(): Promise<void> {
  runtimeOverride = null;
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await AsyncStorage.removeItem('shelly_pro_unlocked');
  } catch {
    // Non-fatal
  }
}
