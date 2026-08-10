/**
 * __tests__/secure-store.test.ts
 *
 * Regression coverage for a code-quality audit finding (2026-08-10):
 * saveApiKey() / saveConnectorSecret() caught SecureStore.setItemAsync()
 * failures and only logged a console.warn — the returned Promise still
 * resolved as if the write succeeded, so a caller had no way to tell a
 * failed save from a successful one (the UI would keep showing a key as
 * "saved" when it was never actually persisted).
 *
 * Fix: both functions now re-throw after logging. This test asserts the
 * re-throw for the write path, and that read/delete behavior (which the
 * task intentionally left untouched — those already "fail closed" by
 * returning null / resolving void, and no caller needed to distinguish a
 * read failure from "key not set") is unchanged.
 */

const mockSecureStoreValues = new Map<string, string>();
let nextSetItemShouldFail = false;

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockSecureStoreValues.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    if (nextSetItemShouldFail) {
      return Promise.reject(new Error('SecureStore write failed (simulated)'));
    }
    mockSecureStoreValues.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockSecureStoreValues.delete(key);
    return Promise.resolve();
  }),
}));

import * as SecureStore from 'expo-secure-store';
import {
  saveApiKey,
  getApiKey,
  deleteApiKey,
  saveConnectorSecret,
  getConnectorSecret,
  deleteConnectorSecret,
} from '@/lib/secure-store';

describe('secure-store — saveApiKey', () => {
  beforeEach(() => {
    mockSecureStoreValues.clear();
    nextSetItemShouldFail = false;
    jest.clearAllMocks();
  });

  it('resolves normally when the underlying write succeeds', async () => {
    await expect(saveApiKey('groqApiKey', 'gk-123')).resolves.toBeUndefined();
    expect(await getApiKey('groqApiKey')).toBe('gk-123');
  });

  it('re-throws when the underlying SecureStore write fails (was previously swallowed)', async () => {
    nextSetItemShouldFail = true;
    await expect(saveApiKey('groqApiKey', 'gk-123')).rejects.toThrow('SecureStore write failed');
    // And the value must NOT appear to have been saved.
    nextSetItemShouldFail = false;
    expect(await getApiKey('groqApiKey')).toBeNull();
  });

  it('read failures still resolve to null rather than throwing (unchanged read-path behavior)', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('read failed'));
    await expect(getApiKey('groqApiKey')).resolves.toBeNull();
  });

  it('delete failures still resolve rather than throwing (unchanged delete-path behavior)', async () => {
    (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(new Error('delete failed'));
    await expect(deleteApiKey('groqApiKey')).resolves.toBeUndefined();
  });
});

describe('secure-store — saveConnectorSecret', () => {
  beforeEach(() => {
    mockSecureStoreValues.clear();
    nextSetItemShouldFail = false;
    jest.clearAllMocks();
  });

  it('resolves normally when the underlying write succeeds', async () => {
    await expect(saveConnectorSecret('my-x', 'refreshToken', 'rt-1')).resolves.toBeUndefined();
    expect(await getConnectorSecret('my-x', 'refreshToken')).toBe('rt-1');
  });

  it('re-throws when the underlying SecureStore write fails (was previously swallowed)', async () => {
    nextSetItemShouldFail = true;
    await expect(saveConnectorSecret('my-x', 'refreshToken', 'rt-1')).rejects.toThrow(
      'SecureStore write failed',
    );
    nextSetItemShouldFail = false;
    expect(await getConnectorSecret('my-x', 'refreshToken')).toBeNull();
  });

  it('still refuses unsafe connector ids / field names (unrelated existing guard, unchanged)', async () => {
    await expect(saveConnectorSecret('bad id!', 'refreshToken', 'v')).rejects.toThrow(
      /unsafe connector id/,
    );
    await expect(saveConnectorSecret('my-x', 'bad field!', 'v')).rejects.toThrow(
      /unsafe field name/,
    );
  });

  it('delete failures still resolve rather than throwing (unchanged delete-path behavior)', async () => {
    await expect(deleteConnectorSecret('my-x', 'refreshToken')).resolves.toBeUndefined();
  });
});
