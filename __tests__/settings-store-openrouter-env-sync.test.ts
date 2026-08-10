/**
 * __tests__/settings-store-openrouter-env-sync.test.ts
 *
 * DEFERRED.md item 8 (2026-08-10 audit): OpenRouter was missing from
 * updateSettings()'s headless `.env` sync (store/settings-store.ts, then
 * lines ~409-431) — Settings saved openrouterApiKey/openrouterModel to
 * SecureStore (for the AI Pane chat client) but never mirrored them to
 * ~/.shelly/agents/.env, so a background/attended agent run using the new
 * lib/agent-executor.ts 'openrouter' dispatch case (OPENROUTER_API_KEY /
 * OPENROUTER_MODEL, read from that .env file) could never see the key even
 * after the user configured it in Settings.
 *
 * Mirrors __tests__/settings-store-api-key-save-failure.test.ts's mocking
 * setup exactly (react-native / expo-secure-store / AsyncStorage are mocked
 * directly rather than pulling in the jest-expo preset, matching that file's
 * own doc comment on why).
 */
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: jest.fn() }),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
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
import { useAgentStore } from '@/store/agent-store';

describe('settings-store — OpenRouter headless .env sync', () => {
  beforeEach(() => {
    useAgentStore.getState().setPendingEnvSync('');
  });

  it('queues OPENROUTER_API_KEY when openrouterApiKey is updated', () => {
    useSettingsStore.getState().updateSettings({ openrouterApiKey: 'sk-or-v1-test-key' });
    const cmd = useAgentStore.getState().pendingEnvSync;
    expect(cmd).toContain('OPENROUTER_API_KEY=');
    expect(cmd).toContain('sk-or-v1-test-key');
  });

  it('queues OPENROUTER_MODEL when openrouterModel is updated', () => {
    useSettingsStore.getState().updateSettings({ openrouterModel: 'anthropic/claude-3.5-sonnet' });
    const cmd = useAgentStore.getState().pendingEnvSync;
    expect(cmd).toContain('OPENROUTER_MODEL=');
    expect(cmd).toContain('anthropic/claude-3.5-sonnet');
  });

  it('does not touch the env sync queue for an unrelated settings update', () => {
    useSettingsStore.getState().updateSettings({ fontSize: 16 });
    expect(useAgentStore.getState().pendingEnvSync).toBe('');
  });

  it('syncs OpenRouter alongside the existing Cerebras/Groq keys in one update (no key clobbers another)', () => {
    useSettingsStore.getState().updateSettings({
      cerebrasApiKey: 'csk-cerebras-test',
      groqApiKey: 'gsk-groq-test',
      openrouterApiKey: 'sk-or-v1-openrouter-test',
    });
    const cmd = useAgentStore.getState().pendingEnvSync;
    expect(cmd).toContain('CEREBRAS_API_KEY=');
    expect(cmd).toContain('GROQ_API_KEY=');
    expect(cmd).toContain('OPENROUTER_API_KEY=');
  });
});
