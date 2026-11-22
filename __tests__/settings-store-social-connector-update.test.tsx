/**
 * __tests__/settings-store-social-connector-update.test.tsx
 *
 * Regression coverage for updateSocialConnectorSecret (2026-08-01), added for
 * the X OAuth pending-token-update drain: X rotates its refresh_token on
 * every exchange, so a successful post must persist the NEW refresh token or
 * the next dispatch's refresh fails with invalid_grant. This action rewrites
 * ONE secret field of an already-registered connector without touching its
 * metadata/fields list — see the doc comment on the store interface.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '@/store/settings-store';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

describe('settings-store — updateSocialConnectorSecret', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    useSettingsStore.setState({ socialConnectors: [] });
  });

  const reservedConnector = {
    id: 'mcp-server', platform: 'x' as const, label: 'Reserved', host: 'api.x.com', fields: ['token'],
  };

  it('propagates the reserved-pair write refusal even if metadata is already in state', async () => {
    useSettingsStore.setState({ socialConnectors: [{ ...reservedConnector, createdAt: 1 }] });
    await expect(
      useSettingsStore.getState().updateSocialConnectorSecret('mcp-server', 'token', 'value'),
    ).rejects.toThrow('reserved');
  });

  it('filters the reserved id during hydration and retains user connectors', async () => {
    const userConnector = { ...reservedConnector, id: 'my-x', createdAt: 2 };
    await AsyncStorage.setItem('shelly_social_connectors', JSON.stringify([
      { ...reservedConnector, createdAt: 1 },
      userConnector,
    ]));

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().socialConnectors).toEqual([userConnector]);
  });

  it('rejects registration of a reserved id regardless of its secret fields', async () => {
    await expect(useSettingsStore.getState().addSocialConnector(
      { ...reservedConnector, fields: ['refreshToken'] }, {},
    )).rejects.toThrow('reserved');
  });

  it('refuses to remove the reserved id before deleting secrets or metadata', async () => {
    const record = { ...reservedConnector, fields: ['refreshToken'], createdAt: 1 };
    useSettingsStore.setState({ socialConnectors: [record] });

    await expect(useSettingsStore.getState().removeSocialConnector('mcp-server'))
      .rejects.toThrow('Connector id is system-reserved: mcp-server');
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().socialConnectors).toEqual([record]);
  });

  it('no-ops when the connector id does not exist (never throws into a poll loop)', async () => {
    await expect(
      useSettingsStore.getState().updateSocialConnectorSecret('nope', 'refreshToken', 'v'),
    ).resolves.toBeUndefined();
  });

  it('no-ops when the field is not one of the connector\'s declared fields', async () => {
    await useSettingsStore.getState().addSocialConnector(
      { id: 'my-x', platform: 'x', label: 'My X', host: 'api.x.com', fields: ['refreshToken', 'clientId'] },
      { refreshToken: 'rt-1', clientId: 'client-1' },
    );
    // 'accessToken' was never declared for this connector — must not be silently accepted.
    await expect(
      useSettingsStore.getState().updateSocialConnectorSecret('my-x', 'accessToken', 'sneaky'),
    ).resolves.toBeUndefined();
  });

  it('no-ops on an unsafe field name (defends the same invariant addSocialConnector enforces)', async () => {
    await useSettingsStore.getState().addSocialConnector(
      { id: 'my-x', platform: 'x', label: 'My X', host: 'api.x.com', fields: ['refreshToken', 'clientId'] },
      { refreshToken: 'rt-1', clientId: 'client-1' },
    );
    await expect(
      useSettingsStore.getState().updateSocialConnectorSecret('my-x', 'bad field!', 'v'),
    ).resolves.toBeUndefined();
  });

  it('rewrites the declared field for an existing connector without touching its metadata', async () => {
    await useSettingsStore.getState().addSocialConnector(
      { id: 'my-x', platform: 'x', label: 'My X', host: 'api.x.com', fields: ['refreshToken', 'clientId'] },
      { refreshToken: 'rt-1', clientId: 'client-1' },
    );
    const before = useSettingsStore.getState().socialConnectors.find((c) => c.id === 'my-x');

    await useSettingsStore.getState().updateSocialConnectorSecret('my-x', 'refreshToken', 'rt-2-rotated');

    const after = useSettingsStore.getState().socialConnectors.find((c) => c.id === 'my-x');
    // Metadata (fields list, host, label, createdAt) is byte-identical — only
    // SecureStore/.env changed, which this store slice doesn't expose directly.
    expect(after).toEqual(before);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'shelly_social-connector.my-x.refreshToken', 'rt-2-rotated',
    );
  });
});
