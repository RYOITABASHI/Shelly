/**
 * The app's side of scripts/shelly-cli-update.js: Claude Code and the Antigravity
 * CLI, which the device fetches from their vendors. All the checking lives in
 * that script, so `claude-install` and the Builds screen cannot disagree.
 *
 * This file only decides when to call it. The app-start pass is off unless the
 * person turned it on. It then runs on an unmetered network, at most once per
 * CHECK interval in the script, and the script skips a CLI nobody installed: the
 * first install is always a person's.
 */
import { execCommand } from '@/hooks/use-native-exec';
import { logError, logInfo } from '@/lib/debug-logger';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

export type ManagedCli = 'claude' | 'agy';

export type ManagedCliStatus = {
  cli: ManagedCli;
  installed: boolean;
  managed: boolean;
  version: string | null;
  previous: string | null;
  channel: string | null;
  latest: string | null;
  latestError?: string | null;
  held: { version: string; stage: string }[];
  agent?: { reviewed: string; version: string | null; enabled: boolean };
};

export type ManagedCliStatuses = Record<ManagedCli, ManagedCliStatus>;

export const MANAGED_CLI_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20 * 1000;
const AUTO_UPDATE_TIMEOUT_MS = 45 * 60 * 1000;

// `node -e`, as in HomeInitializer's __shelly_cli_update: a direct `node file.js`
// hits Node's ESM main-file crash on Android. The CA bundle has to be named here,
// since execCommand's environment is not the terminal's.
export function managedCliCommand(args: readonly ('claude' | 'agy' | 'install' | 'rollback' | 'status' | 'check' | 'auto' | '--agent' | '--force')[]): string {
  return [
    'lib="${SHELLY_LIB_DIR:-${LD_LIBRARY_PATH%%:*}}"',
    'SHELLY_CLI_UPDATE_SCRIPT="$HOME/.shelly-cli-update.js" SHELLY_CLI_UPDATE_MAIN=1 SHELLY_LIB_DIR="$lib"'
      + ' NODE_EXTRA_CA_CERTS="$HOME/.shelly-ssl/ca-certificates.crt" LD_LIBRARY_PATH="$lib"'
      + ' /system/bin/linker64 "$lib/node"'
      + ` -e 'const p=process.env.SHELLY_CLI_UPDATE_SCRIPT; process.argv.splice(1, 0, p); require(p);' ${args.join(' ')}`,
  ].join('; ');
}

export function parseManagedCliStatuses(stdout: string): ManagedCliStatuses | null {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Partial<ManagedCliStatuses>;
    return parsed.claude && parsed.agy ? (parsed as ManagedCliStatuses) : null;
  } catch {
    return null;
  }
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number(part) || 0);
}

export function isNewerVersion(candidate: string, than: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(than);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export type ManagedCliAction = 'install' | 'update' | 'held' | 'none';

export function managedCliAction(status: ManagedCliStatus): ManagedCliAction {
  if (!status.installed) return 'install';
  // A hand-staged copy has no version record. Installing adopts it.
  if (!status.version) return 'update';
  if (!status.latest || !isNewerVersion(status.latest, status.version)) return 'none';
  if (status.held.some((item) => item.version === status.latest)) return 'held';
  return 'update';
}

/** Reads local state only: nothing is started, Antigravity included. */
export async function fetchManagedCliStatuses(mode: 'status' | 'check' = 'check'): Promise<ManagedCliStatuses | null> {
  const result = await execCommand(managedCliCommand([mode]), STATUS_TIMEOUT_MS);
  // A killed `check` must reach the caller, which still has the local status.
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `CLI ${mode} exited ${result.exitCode}`);
  return parseManagedCliStatuses(result.stdout);
}

export async function runManagedCliInstall(cli: ManagedCli, options: { agent?: boolean; force?: boolean } = {}): Promise<string> {
  const args: ('claude' | 'agy' | 'install' | '--agent' | '--force')[] = [cli, 'install'];
  if (options.agent) args.push('--agent');
  if (options.force) args.push('--force');
  const result = await execCommand(managedCliCommand(args), MANAGED_CLI_INSTALL_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.exitCode}`).trim());
  }
  return result.stdout.trim();
}

export async function runManagedCliRollback(cli: ManagedCli): Promise<string> {
  const result = await execCommand(managedCliCommand([cli, 'rollback']), STATUS_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.exitCode}`).trim());
  }
  return result.stdout.trim();
}

export function shouldRunManagedCliAutoUpdate(enabled: boolean | undefined, unmetered: boolean): boolean {
  return enabled === true && unmetered;
}

export async function runManagedCliAutoUpdate(enabled: boolean | undefined): Promise<void> {
  // A build whose native side cannot answer counts as metered: stay off the network.
  const unmetered = enabled === true && (await TerminalEmulator.isNetworkUnmetered?.()) === true;
  if (!shouldRunManagedCliAutoUpdate(enabled, unmetered)) {
    logInfo('ManagedCliUpdate', `app-start update skipped (enabled=${enabled === true}, unmetered=${unmetered})`);
    return;
  }
  const result = await execCommand(managedCliCommand(['auto']), AUTO_UPDATE_TIMEOUT_MS);
  if (result.exitCode === 0) {
    logInfo('ManagedCliUpdate', `app-start update: ${result.stdout.trim().split('\n').pop()?.slice(0, 300)}`);
  } else {
    logError('ManagedCliUpdate', `app-start update failed: ${(result.stderr || '').slice(0, 300)}`);
  }
}
