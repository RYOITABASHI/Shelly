/**
 * __tests__/settings-store-agent-registration-migration.test.tsx
 *
 * Regression coverage for the loadSettings() migration added 2026-07-30.
 *
 * AppSettings.agentRegistrationRequireConfirm defaulted to `false` for a
 * period ending 2026-07-24, when it was reversed to `true` (see the doc
 * comment on DEFAULT_SETTINGS in store/settings-store.ts). loadSettings()
 * merges the persisted AsyncStorage blob OVER DEFAULT_SETTINGS
 * (`{...DEFAULT_SETTINGS, ...persisted}`), so any install that had already
 * written `agentRegistrationRequireConfirm: false` to disk before the
 * reversal kept that stale value forever — the code-level default change
 * never reached it. This was found on-device 2026-07-30 while verifying the
 * widget-ASK no-confirm opt-in (docs/superpowers/DEFERRED.md), where it
 * silently defeated the confirm-by-default safety net with no Settings UI
 * available to correct it (no UI writes this field at all).
 *
 * settings-store.ts imports zustand + AsyncStorage + secure-store + sounds +
 * agent-store, so this runs in the "component" jest project (jest-expo) like
 * __tests__/AgentConfirmCard.test.tsx, which imports the same store the same
 * way with only the AsyncStorage mock below.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '@/store/settings-store';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const SETTINGS_KEY = 'shelly_settings';

async function readPersistedSettings(): Promise<Record<string, unknown> | null> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : null;
}

describe('settings-store loadSettings — agentRegistrationRequireConfirm migration', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('force-corrects a stale persisted false back to true and persists the fix', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentRegistrationRequireConfirm: false }));

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().settings.agentRegistrationRequireConfirm).toBe(true);
    const persisted = await readPersistedSettings();
    expect(persisted?.agentRegistrationRequireConfirm).toBe(true);
  });

  it('defaults to true on a fresh install with nothing persisted', async () => {
    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().settings.agentRegistrationRequireConfirm).toBe(true);
  });

  it('leaves an explicit persisted true untouched', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentRegistrationRequireConfirm: true }));

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().settings.agentRegistrationRequireConfirm).toBe(true);
  });
});
