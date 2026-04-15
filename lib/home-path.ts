/**
 * lib/home-path.ts — Dynamic HOME path resolution
 *
 * Single source of truth for the Plan B HOME directory. The native side
 * (HomeInitializer.kt + shelly-exec.c) decides where ~ lives, and this
 * module asks it directly via the dedicated TerminalEmulator.getHomeDir()
 * binding (bug #73 — previously this used execCommand("echo $HOME"),
 * which ran through the same broken libbash.so path that bug #36 exposed
 * and silently returned an empty string on many devices, leaving the JS
 * layer stuck on the fallback constant).
 */

import { logInfo, logError } from '@/lib/debug-logger';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

// Pre-cache fallback. /data/user/0 is the canonical Android mount;
// /data/data/<pkg> is normally a symlink to the same place but vendors
// occasionally drop it, so prefer the canonical form for the fallback.
let cachedHome: string = '/data/user/0/dev.shelly.terminal/files/home';
let resolved = false;
let inflight: Promise<string> | null = null;

export async function initHomePath(): Promise<string> {
  if (resolved) return cachedHome;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const home = await TerminalEmulator.getHomeDir();
      if (home && home.startsWith('/')) {
        cachedHome = home;
        resolved = true;
        logInfo('HomePath', 'Resolved: ' + cachedHome);
      }
    } catch (e: any) {
      logError('HomePath', 'Failed to resolve HOME, using fallback', e);
    } finally {
      inflight = null;
    }
    return cachedHome;
  })();
  return inflight;
}

export function getHomePath(): string {
  return cachedHome;
}

export function isHomeResolved(): boolean {
  return resolved;
}
