// MEMORY-001 memory layer — expo-file-system FsPort adapter (device side).
//
// Fulfils the FsPort contract from ./types over expo-file-system/legacy — the
// SAME import surface lib/agent-memory.ts (readMemoryNotes) already uses on
// device, so the shadow store reads through the identical, known-good Expo path
// as the live G2 memory. Host tests never load this file (they inject
// __tests__/support/node-fs-port.ts instead); it only runs on device, and only
// when a MEMORY_ENABLED path (shadow.ts today) asks for a port. Dormant:
// "実装されるが有効化はされない."

import * as FileSystem from 'expo-file-system/legacy';
import { Clock, FsPort } from './types';

// Injected wall clock for MemoryStore on device — the pure core never reads
// Date.now directly (see types.ts Clock), so the device wiring supplies it.
export const systemClock: Clock = { now: () => Date.now() };

// Expo FileSystem wants file:// URIs; the storage adapter passes plain paths
// (same normalization agent-memory's toFileUri does).
function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export function createExpoFsPort(): FsPort {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await FileSystem.readAsStringAsync(toFileUri(path));
      } catch {
        // The legacy API throws a generic error for a missing file with no
        // ENOENT-style code to discriminate on, so ANY read failure maps to
        // null ("not there"). The JSON adapter already tolerates missing/
        // corrupt records, so this degrades to a skipped record, never a crash.
        return null;
      }
    },
    async writeFileAtomic(path: string, data: string): Promise<void> {
      // Atomic-ish on Android: write the full payload to a .tmp sibling first,
      // then move it over the target. moveAsync maps to a rename which is not
      // guaranteed to REPLACE an existing destination across Android storage
      // providers, so we delete-then-move. Documented crash window: a crash
      // between delete and move loses the OLD record, but the NEW content is
      // complete in the .tmp sibling and the target is never half-written —
      // acceptable for the shadow store whose ground truth stays G2's .md
      // files. (.tmp lacks the .json suffix, so loadNamespace never reads a
      // leftover temp file as a record.)
      const uri = toFileUri(path);
      const tmpUri = `${uri}.tmp`;
      await FileSystem.writeAsStringAsync(tmpUri, data);
      await FileSystem.deleteAsync(uri, { idempotent: true });
      await FileSystem.moveAsync({ from: tmpUri, to: uri });
    },
    async deleteFile(path: string): Promise<void> {
      // idempotent: deleting a missing file is a no-op, mirroring node-fs-port's
      // ENOENT swallow so both ports satisfy the same contract.
      await FileSystem.deleteAsync(toFileUri(path), { idempotent: true });
    },
    async listFiles(dir: string): Promise<string[]> {
      try {
        return await FileSystem.readDirectoryAsync(toFileUri(dir));
      } catch {
        // Missing dir => empty listing (node-fs-port parity).
        return [];
      }
    },
    async ensureDir(dir: string): Promise<void> {
      // Check-then-make instead of relying on makeDirectoryAsync tolerating an
      // existing dir: legacy Android builds have thrown "directory exists" even
      // with intermediates:true, and mkdir -p semantics are the contract.
      const uri = toFileUri(dir);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
      }
    },
  };
}
