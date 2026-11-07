/**
 * Whether the runtime channel holds something newer than what this device runs.
 *
 * `manifest.version` must equal `codex_tui --version`, so a Termux packaging
 * revision (0.167.0-1) leaves it unchanged. Only codexTermuxVersion carries the
 * revision, so on equal versions that decides. A bundled Codex has no manifest on
 * the device and counts as revision 0: at worst one extra offer, after which the
 * installed runtime has a manifest to compare.
 */

type ChannelRuntime = { version: string; codexTermuxVersion?: string };
type InstalledCodex = { version: string; source: string; termuxVersion?: string };

function versionParts(version: string): number[] {
  return version.replace(/^v/, '').split(/[+-]/)[0].split('.').map((part) => Number(part) || 0);
}

function termuxRevision(version?: string): number {
  const match = /^\d+\.\d+\.\d+-(\d+)$/.exec(version ?? '');
  return match ? Number(match[1]) : 0;
}

export function codexRuntimeUpdateAvailable(latest: ChannelRuntime, installed: InstalledCodex): boolean {
  const left = versionParts(latest.version);
  const right = versionParts(installed.version);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  const installedRevision = installed.source === 'runtime' ? termuxRevision(installed.termuxVersion) : 0;
  return termuxRevision(latest.codexTermuxVersion) > installedRevision;
}
