/**
 * store/settings-store.ts loadSettings() two-phase hydration (2026-10-06
 * boot theme flash). The non-secret AsyncStorage blob (incl. uiFont) must be
 * published BEFORE the slow sequential SecureStore key reads finish, and the
 * later key merge must not clobber updates made in between.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

let resolveKeys: (v: Record<string, string>) => void = () => {};
jest.mock('@/lib/secure-store', () => {
  const actual = jest.requireActual('@/lib/secure-store');
  return {
    ...actual,
    loadApiKeys: jest.fn(() => new Promise((r) => { resolveKeys = r; })),
  };
});

import { useSettingsStore } from '@/store/settings-store';

describe('settings-store loadSettings two-phase hydration', () => {
  afterEach(async () => { await AsyncStorage.clear(); });

  it('publishes the persisted theme before SecureStore keys resolve, then merges keys', async () => {
    await AsyncStorage.setItem('shelly_settings', JSON.stringify({ uiFont: 'case-file' }));
    const done = useSettingsStore.getState().loadSettings();
    // Wait until phase 1 lands while loadApiKeys is still pending.
    for (let i = 0; i < 50 && !useSettingsStore.getState().isBaseSettingsLoaded; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const mid = useSettingsStore.getState();
    expect(mid.isBaseSettingsLoaded).toBe(true);
    expect(mid.isSettingsLoaded).toBe(false);
    expect(mid.settings.uiFont).toBe('case-file');

    // An update in between (e.g. Case File's cursorShape pairing) must survive.
    useSettingsStore.getState().updateSettings({ cursorShape: 'block' });
    resolveKeys({ groqApiKey: 'test-key' });
    await done;

    const end = useSettingsStore.getState();
    expect(end.isSettingsLoaded).toBe(true);
    expect(end.settings.uiFont).toBe('case-file');
    expect(end.settings.cursorShape).toBe('block');
    expect(end.settings.groqApiKey).toBe('test-key');
  });
});
