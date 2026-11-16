/**
 * store/settings-store.ts persist hooks (Codex review 2026-11-15,
 * finding 2): a restrictive MCP change must durably clear the native
 * auto-start mirror BEFORE the narrower settings reach AsyncStorage, and no
 * later settings write may overtake the held-back one. The MCP hook itself
 * (hooks/use-mcp-server-bridge.ts mcpSettingsPersistHook) is covered in
 * __tests__/mcp-server-bridge-hook.test.ts; here the store side is checked
 * with controllable hooks. Mocks follow
 * __tests__/settings-store-api-key-save-failure.test.ts.
 */
const setItemCalls: string[] = [];

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
    setItem: jest.fn((_k: string, v: string) => {
      setItemCalls.push(v);
      return Promise.resolve();
    }),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
  },
}));

import { registerSettingsPersistHook, settingsPersistIdle, useSettingsStore } from '@/store/settings-store';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('settings persist hooks', () => {
  beforeEach(() => {
    setItemCalls.length = 0;
  });

  it('holds a write until beforeWrite resolves; later writes queue behind it and see it first', async () => {
    useSettingsStore.getState().updateSettings({ mcpServerEnabled: true, mcpExecEnabled: true });
    await settingsPersistIdle();
    setItemCalls.length = 0;

    let release!: (ok: boolean) => void;
    const seen: string[] = [];
    const unregister = registerSettingsPersistHook({
      beforeWrite: (next) => {
        seen.push(`before exec=${next.mcpExecEnabled} font=${next.fontSize}`);
        if (next.mcpExecEnabled !== false || seen.length > 1) return null;
        return new Promise<boolean>((r) => { release = r; });
      },
      afterWrite: (next, ok) => { seen.push(`after exec=${next.mcpExecEnabled} ok=${ok}`); },
    });
    try {
      useSettingsStore.getState().updateSettings({ mcpExecEnabled: false });
      // The in-memory state changes at once (UI), the disk write waits.
      expect(useSettingsStore.getState().settings.mcpExecEnabled).toBe(false);
      useSettingsStore.getState().updateSettings({ fontSize: 17 });
      await flush();
      expect(setItemCalls).toEqual([]);
      // The second write's hook has not run yet: hooks run in write order.
      expect(seen).toHaveLength(1);

      release(true);
      await settingsPersistIdle();
      expect(setItemCalls).toHaveLength(2);
      expect(JSON.parse(setItemCalls[0])).toMatchObject({ mcpExecEnabled: false });
      expect(JSON.parse(setItemCalls[0]).fontSize).not.toBe(17);
      expect(JSON.parse(setItemCalls[1])).toMatchObject({ mcpExecEnabled: false, fontSize: 17 });
      expect(seen[1]).toBe('after exec=false ok=true');
    } finally {
      unregister();
    }
  });

  it('skips the write when beforeWrite is not confirmed (false, rejected or throwing)', async () => {
    for (const hook of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error('native gone')),
      () => { throw new Error('boom'); },
    ]) {
      setItemCalls.length = 0;
      const after = jest.fn();
      const unregister = registerSettingsPersistHook({ beforeWrite: hook as any, afterWrite: after });
      try {
        expect(() => useSettingsStore.getState().updateSettings({ mcpServerEnabled: false })).not.toThrow();
        await settingsPersistIdle();
        expect(setItemCalls).toEqual([]);
        expect(after).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    }
    // Once confirmed again, the next write carries the full latest state.
    useSettingsStore.getState().updateSettings({ fontSize: 19 });
    await settingsPersistIdle();
    expect(JSON.parse(setItemCalls[setItemCalls.length - 1])).toMatchObject({ mcpServerEnabled: false, fontSize: 19 });
  });

  it('reports a failed AsyncStorage write to afterWrite', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    const after = jest.fn();
    const unregister = registerSettingsPersistHook({ afterWrite: after });
    try {
      useSettingsStore.getState().updateSettings({ mcpExecEnabled: true });
      await settingsPersistIdle();
      expect(after).toHaveBeenCalledWith(expect.objectContaining({ mcpExecEnabled: true }), false);
    } finally {
      unregister();
    }
  });

  it('mcpTypedOpsEnabled defaults OFF and is held back / persisted like the other MCP switches', async () => {
    expect(useSettingsStore.getState().settings.mcpTypedOpsEnabled).toBe(false);
    useSettingsStore.getState().updateSettings({ mcpServerEnabled: true, mcpTypedOpsEnabled: true });
    await settingsPersistIdle();
    setItemCalls.length = 0;

    let release!: (ok: boolean) => void;
    const after = jest.fn();
    const unregister = registerSettingsPersistHook({
      beforeWrite: (next) => (next.mcpTypedOpsEnabled === false ? new Promise<boolean>((r) => { release = r; }) : null),
      afterWrite: after,
    });
    try {
      useSettingsStore.getState().updateSettings({ mcpTypedOpsEnabled: false });
      expect(useSettingsStore.getState().settings.mcpTypedOpsEnabled).toBe(false); // memory at once
      await flush();
      expect(setItemCalls).toEqual([]); // disk write waits for the hook
      release(true);
      await settingsPersistIdle();
      expect(JSON.parse(setItemCalls[0])).toMatchObject({ mcpTypedOpsEnabled: false });
      expect(after).toHaveBeenCalledWith(expect.objectContaining({ mcpTypedOpsEnabled: false }), true);
    } finally {
      unregister();
    }
  });

  it('tells hooks what was loaded from disk', async () => {
    const loaded = jest.fn();
    const unregister = registerSettingsPersistHook({ loaded });
    try {
      await useSettingsStore.getState().loadSettings();
      expect(loaded).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
