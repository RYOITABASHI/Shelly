/**
 * lib/backup/device.ts — wires lib/backup/service.ts to the real device APIs.
 * Device-only (expo modules); host tests inject fakes into the service instead.
 */
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { execCommand } from '@/hooks/use-native-exec';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import type { BackupDeps, FsLike } from './service';

function appVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    return typeof pkg?.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

const fsAdapter: FsLike = {
  readAsStringAsync: (uri, opts) =>
    FileSystem.readAsStringAsync(uri, {
      encoding: opts?.encoding === 'base64' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
    }),
  writeAsStringAsync: (uri, data, opts) =>
    FileSystem.writeAsStringAsync(uri, data, {
      encoding: opts?.encoding === 'base64' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
    }),
  getInfoAsync: async (uri, opts) => {
    void opts; // legacy getInfoAsync always reports size for existing files
    const info = await FileSystem.getInfoAsync(uri);
    return {
      exists: info.exists,
      isDirectory: info.exists ? info.isDirectory : false,
      size: info.exists ? (info as { size?: number }).size : undefined,
    };
  },
  makeDirectoryAsync: (uri, opts) => FileSystem.makeDirectoryAsync(uri, opts),
  deleteAsync: (uri, opts) => FileSystem.deleteAsync(uri, opts),
};

export function createDeviceBackupDeps(): BackupDeps {
  const setSeal = TerminalEmulator.setAgentPolicySeal?.bind(TerminalEmulator);
  return {
    exec: (cmd, timeoutMs) => execCommand(cmd, timeoutMs),
    fs: fsAdapter,
    asyncStorage: {
      getAllKeys: () => AsyncStorage.getAllKeys(),
      multiGet: (keys) => AsyncStorage.multiGet(keys),
      multiSet: (pairs) => AsyncStorage.multiSet(pairs),
    },
    secureStore: {
      getItemAsync: (k) => SecureStore.getItemAsync(k),
      setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
    },
    homeUri: `${FileSystem.documentDirectory}home/`,
    appVersion: appVersion(),
    setNativePolicySeal: setSeal ? (v: string) => setSeal(v) : undefined,
  };
}

/**
 * Restart the JS app so every store re-hydrates from the restored storage.
 * expo-updates' reloadAsync relaunches the React instance (it works with
 * updates disabled too on current SDKs); returns false when no reload path
 * is available — the UI then asks the user to force-close and reopen.
 */
export async function reloadAppAfterRestore(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Updates = require('expo-updates');
    if (typeof Updates?.reloadAsync === 'function') {
      await Updates.reloadAsync();
      return true;
    }
  } catch {
    // fall through
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DevSettings } = require('react-native');
    if (__DEV__ && DevSettings?.reload) {
      DevSettings.reload();
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}
