/**
 * lib/fs-native.ts — In-process directory listing via JNI.
 *
 * Bug #70: shelling out to `ls` through libbash.so + linker64 returns
 * exit=0 stdout=0chars on some devices (same class of failure as bug #36
 * with `cat /proc/net/tcp`). The fix is to bypass the shell entirely and
 * call opendir/readdir/lstat from the app process itself — `ShellyJNI.readDir`
 * in `modules/terminal-emulator/android/src/main/jni/shelly-exec.c`.
 *
 * This module is the thin JS parser for its output. The native side emits
 * tab-delimited lines:
 *
 *     NAME\tTYPE\tSIZE\n
 *
 * where TYPE is one of 'd' (directory), 'f' (regular file), 'l' (symlink),
 * '?' (other). Dots ('.' / '..') are pre-filtered by the native side.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

export interface DirEntry {
  name: string;
  type: 'd' | 'f' | 'l' | '?';
  size: number;
}

/**
 * List a directory via the native JNI path. Returns `[]` on any error
 * (missing dir, permission denied, IO failure). Never throws.
 */
export async function readDirEntries(path: string): Promise<DirEntry[]> {
  let raw = '';
  try {
    raw = await TerminalEmulator.readDir(path);
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, type, sizeStr] = line.split('\t');
      const t: DirEntry['type'] =
        type === 'd' || type === 'f' || type === 'l' ? type : '?';
      return {
        name: name ?? '',
        type: t,
        size: parseInt(sizeStr ?? '0', 10) || 0,
      };
    })
    .filter((e) => e.name.length > 0);
}
