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

/**
 * Native file surface (TerminalEmulator module), injectable for tests.
 *
 * Listing and deletion are native because expo-file-system/legacy cannot
 * delete files under getExternalFilesDir(): its deleteAsync() requires WRITE
 * on `<file>/..`, and for paths outside filesDir/cacheDir that check is
 * File("<file>.apk/..").canWrite(), i.e. access() on a path through a regular
 * file -> ENOTDIR -> "isn't deletable". On build 2789 every delete was
 * rejected and the swallowed error made the cleanup a silent no-op.
 *
 * The native side only ever touches direct regular-file (non-symlink)
 * children whose names match the same patterns; JS decides which ones.
 */
export type CleanupBridge = {
  listReleaseApks?(): Promise<string[]>;
  deleteReleaseApk?(name: string): Promise<boolean>;
  listLegacyUpdateDirs?(): Promise<{ name: string; entries: { name: string; isDirectory: boolean }[] }[]>;
  deleteLegacyUpdateDir?(name: string): Promise<boolean>;
};

export type ApkCleanupResult = {
  /** Release APK names listed in the download dir. */
  found: number;
  /** Names the selector picked for deletion. */
  selected: number;
  /** Names actually deleted. */
  deleted: string[];
  /** Per-file / listing errors (message only), for logging. */
  errors: string[];
  /** True when the native methods are missing (older native build). */
  unsupported?: boolean;
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** List release APK names via the native bridge. Throws on native failure. */
export async function listReleaseApks(bridge: CleanupBridge): Promise<string[] | null> {
  if (typeof bridge.listReleaseApks !== 'function') return null;
  const names = await bridge.listReleaseApks();
  return Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
}

/**
 * Delete the given names (re-filtered through RELEASE_APK_NAME_RE as defense
 * in depth). Individual failures are recorded, never thrown.
 */
export async function deleteReleaseApks(
  bridge: CleanupBridge,
  names: readonly string[],
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];
  if (typeof bridge.deleteReleaseApk !== 'function') {
    return { deleted, errors: names.length > 0 ? ['deleteReleaseApk unavailable'] : [] };
  }
  for (const name of names) {
    if (!isReleaseApkFileName(name)) continue;
    try {
      if (await bridge.deleteReleaseApk(name)) deleted.push(name);
      else errors.push(`${name}: not deleted`);
    } catch (e) {
      errors.push(`${name}: ${errorMessage(e)}`);
    }
  }
  return { deleted, errors };
}

/** List -> select -> delete. Never throws. */
export async function cleanupReleaseApks(
  bridge: CleanupBridge,
  select: (names: string[]) => string[],
): Promise<ApkCleanupResult> {
  let names: string[] | null;
  try {
    names = await listReleaseApks(bridge);
  } catch (e) {
    return { found: 0, selected: 0, deleted: [], errors: [`list: ${errorMessage(e)}`] };
  }
  if (names == null) return { found: 0, selected: 0, deleted: [], errors: [], unsupported: true };
  const stale = select(names);
  const { deleted, errors } = stale.length > 0 ? await deleteReleaseApks(bridge, stale) : { deleted: [], errors: [] };
  return { found: names.length, selected: stale.length, deleted, errors };
}

/** Remove stale legacy public-Downloads `shelly-update-*` dirs. Never throws. */
export async function cleanupLegacyUpdateDirs(
  bridge: CleanupBridge,
  installedVersionCode: number,
): Promise<ApkCleanupResult> {
  if (typeof bridge.listLegacyUpdateDirs !== 'function' || typeof bridge.deleteLegacyUpdateDir !== 'function') {
    return { found: 0, selected: 0, deleted: [], errors: [], unsupported: true };
  }
  let dirs: { name: string; entries: { name: string; isDirectory: boolean }[] }[];
  try {
    dirs = (await bridge.listLegacyUpdateDirs()) ?? [];
  } catch (e) {
    return { found: 0, selected: 0, deleted: [], errors: [`list: ${errorMessage(e)}`] };
  }
  const byName = new Map(dirs.map((d) => [d.name, d.entries ?? []]));
  const candidates = selectStaleLegacyUpdateDirs([...byName.keys()], installedVersionCode).filter((name) =>
    legacyDirContentsRemovable(byName.get(name) ?? []),
  );
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const name of candidates) {
    try {
      if (await bridge.deleteLegacyUpdateDir(name)) deleted.push(name);
      else errors.push(`${name}: not deleted`);
    } catch (e) {
      errors.push(`${name}: ${errorMessage(e)}`);
    }
  }
  return { found: dirs.length, selected: candidates.length, deleted, errors };
}

/** One-line log summary of a cleanup result. */
export function describeCleanupResult(label: string, r: ApkCleanupResult): string {
  if (r.unsupported) return `${label}: native cleanup methods unavailable (old native build)`;
  const err = r.errors.length > 0 ? ` errors=${r.errors.length} [${r.errors.slice(0, 3).join('; ')}]` : '';
  return `${label}: found=${r.found} selected=${r.selected} deleted=${r.deleted.length}${err}`;
}
