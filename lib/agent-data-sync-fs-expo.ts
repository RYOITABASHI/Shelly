// lib/agent-data-sync-fs-expo.ts — expo-file-system adapter for
// lib/agent-data-sync.ts's SyncFsPort contract (device side only).
//
// Separate file from lib/agent-data-sync.ts (kept dependency-free for unit
// testing) and from lib/memory/fs-expo.ts (that one implements the
// FsPort contract, which has no isDirectory concept — SyncFsPort needs one
// to tell a memory agentId subdirectory apart from a plain file).
import * as FileSystem from 'expo-file-system/legacy';
import { SyncFsPort } from './agent-data-sync';

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export function createAgentDataSyncFsPort(): SyncFsPort {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await FileSystem.readAsStringAsync(toFileUri(path));
      } catch {
        return null;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await FileSystem.writeAsStringAsync(toFileUri(path), data);
    },
    async deleteFile(path: string): Promise<void> {
      await FileSystem.deleteAsync(toFileUri(path), { idempotent: true });
    },
    async listEntries(dir: string) {
      try {
        const dirUri = toFileUri(dir);
        const info = await FileSystem.getInfoAsync(dirUri);
        if (!info.exists || !info.isDirectory) return [];
        const names = await FileSystem.readDirectoryAsync(dirUri);
        const entries = await Promise.all(
          names.map(async (name) => {
            const entryInfo = await FileSystem.getInfoAsync(`${dirUri}/${name}`);
            return { name, isDirectory: entryInfo.exists && entryInfo.isDirectory };
          }),
        );
        return entries;
      } catch {
        return [];
      }
    },
    async ensureDir(dir: string): Promise<void> {
      const uri = toFileUri(dir);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
      }
    },
  };
}
