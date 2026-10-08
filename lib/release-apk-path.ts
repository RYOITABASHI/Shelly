// lib/release-apk-path.ts
//
// Path/URI helpers for the in-app APK updater (components/layout/BuildsModal.tsx).
//
// 2026-10-08 on-device finding (build 2478, Galaxy Z Fold6): the updater
// failed in BOTH transports when Shelly ran as a Samsung Dual Messenger clone
// (Android user 95, `u95_a888`). The JS side hardcoded
// `/storage/emulated/0/Android/data/dev.shelly.terminal/files/Download`, but
// the native DownloadManager destination is
// `getExternalFilesDir(DIRECTORY_DOWNLOADS)`, which for user 95 is
// `/storage/emulated/95/...` (logcat: `enqueueApkDownload: id=4
// target=/storage/emulated/95/...`). So:
//   1. the DownloadManager download landed in user 95's dir, but the JS verify
//      step looked in user 0's dir ("APK not found") -> fell back; and
//   2. the expo-file-system direct fallback targeted user 0's dir, which a
//      user-95 process cannot see, so `File.parentFile.exists()` was false
//      ("Directory for '...' doesn't exist") even though `adb shell ls` (which
//      runs as user 0's view) showed the directory.
// The download dir must come from the native side (or, failing that, be
// derived from the running user's own app-data path), never be hardcoded.

export const APK_DOWNLOAD_SUBDIR = 'Android/data/dev.shelly.terminal/files/Download';

/** Strip trailing slashes (but keep a bare "/"). */
function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Normalize a filesystem path or URI into a `file://` URI with exactly one
 * scheme prefix and an absolute path. Accepts `/abs/path`, `file:/abs`,
 * `file:///abs`, and accidentally double-prefixed `file://file:///abs`.
 */
export function toFileUri(pathOrUri: string): string {
  let p = String(pathOrUri ?? '').trim();
  if (!p) throw new Error('toFileUri: empty path');
  // Peel any number of file: prefixes (handles double-prefixing).
  while (/^file:/i.test(p)) {
    p = p.replace(/^file:(\/\/)?/i, '');
  }
  if (!p.startsWith('/')) {
    throw new Error(`toFileUri: expected an absolute path, got '${pathOrUri}'`);
  }
  // Collapse leading slashes so we always emit file:///abs.
  p = '/' + p.replace(/^\/+/, '');
  return `file://${p}`;
}

/** Inverse of toFileUri: return a plain absolute path. */
export function fromFileUri(pathOrUri: string): string {
  return toFileUri(pathOrUri).slice('file://'.length);
}

/**
 * Extract the Android user id from an app-data path/URI such as expo's
 * `documentDirectory` (`file:///data/user/95/dev.shelly.terminal/files/`).
 * `/data/data/<pkg>` is the user-0 alias. Returns null when unrecognized.
 */
export function androidUserIdFromAppDataPath(pathOrUri: string | null | undefined): number | null {
  if (!pathOrUri) return null;
  let path: string;
  try {
    path = fromFileUri(pathOrUri);
  } catch {
    return null;
  }
  const m = /^\/data\/user(?:_de)?\/(\d+)\//.exec(path);
  if (m) return Number(m[1]);
  if (/^\/data\/data\//.test(path)) return 0;
  return null;
}

/**
 * Resolve the absolute release-APK download directory.
 *
 * Priority:
 *   1. the native `getExternalFilesDir(DIRECTORY_DOWNLOADS)` path (authoritative,
 *      identical to the DownloadManager destination);
 *   2. `/storage/emulated/<userId>/Android/data/<pkg>/files/Download`, with the
 *      user id derived from the running process's own app-data dir;
 *   3. user 0 (the historical hardcoded value).
 */
export function resolveReleaseApkDir(opts: {
  nativeDir?: string | null;
  appDataDir?: string | null;
}): string {
  if (opts.nativeDir && opts.nativeDir.trim()) {
    try {
      return trimTrailingSlash(fromFileUri(opts.nativeDir));
    } catch {
      // fall through to derived path
    }
  }
  const userId = androidUserIdFromAppDataPath(opts.appDataDir) ?? 0;
  return `/storage/emulated/${userId}/${APK_DOWNLOAD_SUBDIR}`;
}

export function joinApkPath(dir: string, fileName: string): string {
  return `${trimTrailingSlash(dir)}/${fileName}`;
}

/** Minimal slice of expo-file-system/legacy used by ensureDirectory (injectable for tests). */
export type DirectoryFs = {
  makeDirectoryAsync(uri: string, options?: { intermediates?: boolean }): Promise<void>;
  getInfoAsync(uri: string): Promise<{ exists: boolean; isDirectory?: boolean }>;
};

/**
 * Ensure `dir` exists as a directory, using the SAME normalized `file://` URI
 * form for the mkdir and for the existence check. Unlike the previous
 * `makeDirectoryAsync(...).catch(() => undefined)`, a failure here is surfaced
 * with the real reason instead of resurfacing later as expo's misleading
 * "Directory for '...' doesn't exist" from downloadResumableStartAsync.
 * Returns the normalized directory URI.
 */
export async function ensureDirectory(fs: DirectoryFs, dir: string): Promise<string> {
  const dirUri = toFileUri(dir);
  let mkdirError: unknown = null;
  try {
    await fs.makeDirectoryAsync(dirUri, { intermediates: true });
  } catch (e) {
    // expo's legacy makeDirectoryAsync rejects with "isn't writable" for an
    // external path that does not exist yet (its permission check is
    // File.canWrite()), and also when the dir already exists on some paths.
    // Decide on the post-condition, not on the mkdir result.
    mkdirError = e;
  }
  const info = await fs.getInfoAsync(dirUri).catch(() => ({ exists: false, isDirectory: false }));
  if (info.exists && info.isDirectory !== false) return dirUri;
  const reason = mkdirError ? `: ${String((mkdirError as any)?.message ?? mkdirError)}` : '';
  throw new Error(`Download directory is not accessible from this app: ${fromFileUri(dirUri)}${reason}`);
}
