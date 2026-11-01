// lib/release-apk-cleanup.ts
//
// Stale-APK cleanup for the in-app updater (components/layout/BuildsModal.tsx).
//
// 2026-11-02 rehearsal finding (DEFERRED.md P1 (p)): every update downloads a
// ~660MB `Shelly-android-*.apk` into the app-specific
// `getExternalFilesDir(DIRECTORY_DOWNLOADS)` dir and nothing ever deleted one;
// 50 files / 33GB had piled up on the test device.
//
// Safety rules (enforced by the pure selectors below, which are the only
// thing deciding what gets deleted):
//   * Only plain file names matching RELEASE_APK_NAME_RE, directly inside the
//     app-owned APK download dir. Never subdirectories (`packs/`), never
//     anything else in that dir, never the public /sdcard/Download files.
//   * Never the APK about to be downloaded, the in-flight DownloadManager
//     target, or any APK handed to the system installer in this session (the
//     installer may still be reading it).
//   * On startup, only APKs whose versionCode is <= the installed versionCode
//     (already installed or a downgrade Android would refuse anyway); names
//     without a parseable versionCode are kept.
//   * Legacy `/sdcard/Download/shelly-update-<...>-<versionCode>/` dirs (the
//     pre-targetSdk-36 updater destination, a name this code base wrote) are
//     removed only when their versionCode is <= installed AND they contain
//     nothing but `.apk` files.

/** Asset names: Shelly-android-v<ver>-<versionCode>-<run>-<attempt>-<sha12>.apk */
export const RELEASE_APK_NAME_RE = /^Shelly-android-[A-Za-z0-9._-]+\.apk$/;
const RELEASE_APK_VERSION_RE = /^Shelly-android-v[0-9A-Za-z._]+-(\d+)-\d+-\d+-[0-9a-fA-F]+\.apk$/;
export const LEGACY_UPDATE_DIR_RE = /^shelly-update-(?:[A-Za-z0-9._-]+-)?(\d+)$/;

export function isReleaseApkFileName(name: string): boolean {
  return typeof name === 'string' && RELEASE_APK_NAME_RE.test(name);
}

/** versionCode embedded in a release asset name, or null when unparseable. */
export function releaseApkVersionCode(name: string): number | null {
  const m = RELEASE_APK_VERSION_RE.exec(name);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

export function legacyUpdateDirVersionCode(name: string): number | null {
  const m = LEGACY_UPDATE_DIR_RE.exec(name);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

function baseName(pathOrName: string): string {
  const s = String(pathOrName ?? '').replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

function protectedNameSet(protectedPaths: Iterable<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const p of protectedPaths) {
    if (p) out.add(baseName(p));
  }
  return out;
}

/**
 * Before enqueueing a new download: every release APK in the dir except the
 * one about to be downloaded and any protected (in-flight / handed-off) file.
 */
export function selectStaleApksBeforeDownload(
  names: readonly string[],
  keepName: string,
  protectedPaths: Iterable<string | null | undefined> = [],
): string[] {
  const keep = protectedNameSet(protectedPaths);
  keep.add(baseName(keepName));
  return names.filter((name) => isReleaseApkFileName(name) && !keep.has(name));
}

/**
 * On app start: release APKs already installed (versionCode <= installed).
 * Newer APKs (a pending update the user may still install) and unparseable
 * names are kept.
 */
export function selectStaleApksOnStartup(
  names: readonly string[],
  installedVersionCode: number,
  protectedPaths: Iterable<string | null | undefined> = [],
): string[] {
  if (!Number.isFinite(installedVersionCode) || installedVersionCode < 1) return [];
  const keep = protectedNameSet(protectedPaths);
  return names.filter((name) => {
    if (!isReleaseApkFileName(name) || keep.has(name)) return false;
    const code = releaseApkVersionCode(name);
    return code != null && code <= installedVersionCode;
  });
}

/** Legacy public-Downloads updater dirs that are safe to remove. */
export function selectStaleLegacyUpdateDirs(
  names: readonly string[],
  installedVersionCode: number,
): string[] {
  if (!Number.isFinite(installedVersionCode) || installedVersionCode < 1) return [];
  return names.filter((name) => {
    const code = legacyUpdateDirVersionCode(name);
    return code != null && code <= installedVersionCode;
  });
}

/** A legacy dir may be removed only if it holds nothing but `.apk` files. */
export function legacyDirContentsRemovable(entries: readonly { name: string; isDirectory: boolean }[]): boolean {
  return entries.every((e) => !e.isDirectory && /^[A-Za-z0-9._-]+\.apk$/i.test(e.name));
}

/** Minimal file-system surface (expo-file-system/legacy compatible), injectable for tests. */
export type CleanupFs = {
  readDirectoryAsync(uri: string): Promise<string[]>;
  getInfoAsync(uri: string): Promise<{ exists: boolean; isDirectory?: boolean }>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
};

function dirUri(dir: string): string {
  const d = dir.replace(/\/+$/, '');
  return d.startsWith('file://') ? d : `file://${d}`;
}

function joinUri(dir: string, name: string): string {
  return `${dirUri(dir)}/${name}`;
}

/**
 * Delete the given names from `dir`, skipping anything that is not a plain
 * file. Best effort: individual failures are swallowed. Returns deleted names.
 */
export async function deleteApkFiles(fs: CleanupFs, dir: string, names: readonly string[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of names) {
    // Defense in depth: never let a caller-supplied name escape the dir.
    if (!isReleaseApkFileName(name)) continue;
    const uri = joinUri(dir, name);
    try {
      const info = await fs.getInfoAsync(uri);
      if (!info.exists || info.isDirectory) continue;
      await fs.deleteAsync(uri, { idempotent: true });
      deleted.push(name);
    } catch {
      // best effort
    }
  }
  return deleted;
}

export async function listDir(fs: CleanupFs, dir: string): Promise<string[]> {
  try {
    return await fs.readDirectoryAsync(dirUri(dir));
  } catch {
    return [];
  }
}

/** Remove stale legacy `shelly-update-*` dirs under `publicDownloadDir`. */
export async function cleanupLegacyUpdateDirs(
  fs: CleanupFs,
  publicDownloadDir: string,
  installedVersionCode: number,
): Promise<string[]> {
  const removed: string[] = [];
  const candidates = selectStaleLegacyUpdateDirs(await listDir(fs, publicDownloadDir), installedVersionCode);
  for (const dirName of candidates) {
    const legacyUri = joinUri(publicDownloadDir, dirName);
    try {
      const info = await fs.getInfoAsync(legacyUri);
      if (!info.exists || !info.isDirectory) continue;
      const childNames = await fs.readDirectoryAsync(legacyUri);
      const children: { name: string; isDirectory: boolean }[] = [];
      for (const name of childNames) {
        const ci = await fs.getInfoAsync(`${legacyUri}/${name}`);
        children.push({ name, isDirectory: !!ci.isDirectory });
      }
      if (!legacyDirContentsRemovable(children)) continue;
      for (const child of children) {
        await fs.deleteAsync(`${legacyUri}/${child.name}`, { idempotent: true });
      }
      // Remove the dir itself only once it is verifiably empty (never a
      // recursive delete of the dir).
      const remaining = await fs.readDirectoryAsync(legacyUri).catch(() => ['?']);
      if (remaining.length === 0) {
        await fs.deleteAsync(legacyUri, { idempotent: true });
      }
      removed.push(dirName);
    } catch {
      // best effort
    }
  }
  return removed;
}
