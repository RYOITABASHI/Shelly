/**
 * __tests__/settings-store-api-key-save-failure.test.ts
 *
 * Regression coverage for a code-quality audit finding (2026-08-10):
 * updateSettings() saved API keys to SecureStore fire-and-forget
 * (`saveApiKey(key, value);`, not awaited, no .catch). Combined with the
 * old secure-store.ts behavior of swallowing write failures, a failed
 * SecureStore write was completely invisible — the Settings UI kept
 * showing the just-typed key as "saved" while it was never persisted.
 *
 * lib/secure-store.ts's saveApiKey() now re-throws on failure (see
 * __tests__/secure-store.test.ts). This test covers the other half: that
 * updateSettings() — a synchronous zustand action many call sites depend on
 * staying void-returning, so it can't simply `await` the save — still
 * detects that rejection and surfaces it to the user via Alert instead of
 * letting it disappear as an unhandled promise rejection.
 *
 * store/settings-store.ts pulls in `react-native` (Alert, and transitively
 * Platform/AccessibilityInfo via lib/sounds.ts's useSoundStore). This
 * project has no React Native test renderer harness for the plain
 * `*.test.ts` (node) project (see jest.config.cjs), so — same approach as
 * __tests__/use-skill-save-offer.test.ts — react-native and the native
 * expo-secure-store module are mocked directly rather than pulling in the
 * jest-expo preset.
 */
let nextSetItemShouldFail = false;
const alertMock = jest.fn();

jest.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => alertMock(...args) },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: jest.fn() }),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => {
    if (nextSetItemShouldFail) {
      return Promise.reject(new Error('SecureStore write failed (simulated)'));
    }
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
  },
}));

import { useSettingsStore } from '@/store/settings-store';

describe('settings-store — updateSettings API key save failure surfacing', () => {
  beforeEach(() => {
    nextSetItemShouldFail = false;
    alertMock.mockClear();
  });

  it('does not alert when the SecureStore write succeeds', async () => {
    useSettingsStore.getState().updateSettings({ groqApiKey: 'gk-good' });
    // Let the fire-and-forget saveApiKey().catch(...) microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('alerts the user when the SecureStore write fails, without throwing out of updateSettings', async () => {
    nextSetItemShouldFail = true;
    expect(() => {
      useSettingsStore.getState().updateSettings({ groqApiKey: 'gk-bad' });
    }).not.toThrow();
    // Flush the microtask queue so the rejected saveApiKey promise's .catch runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(alertMock).toHaveBeenCalledTimes(1);
    const [title, message] = alertMock.mock.calls[0];
    expect(title).toMatch(/failed/i);
    expect(message).toContain('groqApiKey');
  });

  it('does not alert for a settings update that touches no API key field', async () => {
    useSettingsStore.getState().updateSettings({ fontSize: 16 });
    await Promise.resolve();
    await Promise.resolve();
    expect(alertMock).not.toHaveBeenCalled();
  });
});
