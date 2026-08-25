/**
 * lib/optional-pack-installer.ts — download + extract for `shelly install <pack>`.
 *
 * Fable5 roadmap item #6 (on-demand optional-tool packs). This is the JS-side
 * orchestration that `lib/pseudo-shell.ts`'s `shelly install` subcommand
 * drives. It reuses the SAME Android DownloadManager mechanism the in-app
 * self-updater already uses for APK downloads
 * (`TerminalEmulator.enqueueApkDownload` → `setDestinationInExternalFilesDir`,
 * NOT `setDestinationInExternalPublicDir`, which throws SecurityException on
 * modern targetSdk — see components/layout/BuildsModal.tsx's
 * `downloadReleaseApk` for the precedent this fixed once already) via three
 * new native methods on the same bridge:
 *
 *   - `enqueuePackDownload` — generic sibling of `enqueueApkDownload` (no
 *     APK-specific mimetype/extension assumptions), targets
 *     Download/packs/<fileName> instead of Download/<fileName>.
 *   - `getApkDownloadStatus` / `removeApkDownload` — REUSED as-is. Both are
 *     already fully generic (keyed only by downloadId), so no pack-specific
 *     native duplicate was added.
 *   - `verifyPackArchive` — generic sibling of `verifyApkFile` (checks
 *     `.tar.gz` instead of `.apk`).
 *   - `extractPackArchive` — new native entry point wrapping
 *     `LibExtractor.extractPack()` (modules/terminal-emulator/android/.../
 *     LibExtractor.kt), which is an ADDITIVE method never called by the
 *     existing unconditional first-launch `extractAll()` path.
 *
 * All four new native methods are typed `?` (optional) on
 * TerminalEmulatorModuleType, following the file's existing convention for
 * newer bridge surface — so this module and its tests can run against a
 * native module double that doesn't implement them, and `shelly install`
 * degrades to a clear error instead of a crash on an old build.
 *
 * Explicitly NOT done here (deferred remainder, see CLAUDE.md item #6):
 *   - No pack archive has actually been built or published — every
 *     `OptionalPackManifest.published` is `false`, so `installOptionalPack`
 *     refuses before ever calling the download bridge.
 *   - PATH wiring ($HOME/bin symlinks) is not attempted. Binaries land under
 *     app-private storage (`termux-libs/packs/<packId>/`) but a shell won't
 *     find them until a future HomeInitializer.kt bashrc change adds that —
 *     deliberately out of scope for this task (native build-system /
 *     always-on bashrc-generation change, can't be verified without a device).
 */

export type PackDownloadStatus = {
  status: 'pending' | 'running' | 'paused' | 'successful' | 'failed' | 'missing' | 'unknown';
  reason: number;
  downloadedBytes: number;
  totalBytes: number;
};

/** Minimal shape of the native bridge this module needs — a structural
 *  subset of TerminalEmulatorModuleType so tests can pass a plain mock
 *  object instead of importing the real native module. */
export type PackNativeBridge = {
  enqueuePackDownload: (
    url: string,
    packId: string,
    fileName: string
  ) => Promise<{ downloadId: number; path: string }>;
  getApkDownloadStatus: (downloadId: number) => Promise<PackDownloadStatus>;
  removeApkDownload: (downloadId: number) => Promise<void>;
  verifyPackArchive?: (
    archivePath: string,
    expectedSha256: string,
    expectedSizeBytes: number
  ) => Promise<{ ok: boolean; actualSha256: string; bytes: number; error?: string | null }>;
  extractPackArchive?: (
    packId: string,
    archivePath: string,
    tools: string[]
  ) => Promise<{ extractedPaths: string[]; libDir: string }>;
};

export class PackNotPublishedError extends Error {
  constructor(packId: string) {
    super(
      `Pack '${packId}' has no published release asset yet (this is deferred remainder work — ` +
        'see CLAUDE.md item #6 / DEFERRED.md; the download URL is a placeholder, not a real asset).'
    );
    this.name = 'PackNotPublishedError';
  }
}

export type OptionalPackLike = {
  id: string;
  tools: string[];
  archiveAssetName: string;
  downloadUrl: string;
  sha256: string | null;
  approxSizeBytes: number | null;
  published: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_STATUSES = new Set(['successful', 'failed', 'missing', 'unknown']);

export type InstallOptionalPackOptions = {
  /** Poll interval while waiting on the DownloadManager status, ms. Default 1000. */
  pollIntervalMs?: number;
  /** Max polls before giving up as a timeout. Default 1800 (~30 min at 1s). */
  maxPolls?: number;
};

/**
 * Downloads, verifies (when a sha256 is known), and extracts one optional
 * pack. Throws on any failure — callers (pseudo-shell.ts) turn that into a
 * single error OutputLine, matching the existing `shelly skill import` /
 * `shelly config` error-reporting convention.
 */
export async function installOptionalPack(
  pack: OptionalPackLike,
  bridge: PackNativeBridge,
  options: InstallOptionalPackOptions = {}
): Promise<{ extractedPaths: string[]; libDir: string }> {
  if (!pack.published) {
    throw new PackNotPublishedError(pack.id);
  }
  if (typeof bridge.extractPackArchive !== 'function') {
    throw new Error(
      'Pack extraction is not supported by this build of Shelly (missing native extractPackArchive). Update Shelly and try again.'
    );
  }

  const { downloadId, path: archivePath } = await bridge.enqueuePackDownload(
    pack.downloadUrl,
    pack.id,
    pack.archiveAssetName
  );
  if (!Number.isFinite(downloadId) || downloadId < 1) {
    throw new Error(`Could not start download for pack '${pack.id}'.`);
  }

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPolls = options.maxPolls ?? 1800;
  let polls = 0;
  while (true) {
    if (polls >= maxPolls) {
      await bridge.removeApkDownload(downloadId).catch(() => undefined);
      throw new Error(`Pack '${pack.id}' download timed out.`);
    }
    polls += 1;
    await sleep(pollIntervalMs);
    const status = await bridge.getApkDownloadStatus(downloadId);
    if (status.status === 'successful') break;
    if (TERMINAL_STATUSES.has(status.status)) {
      await bridge.removeApkDownload(downloadId).catch(() => undefined);
      throw new Error(
        `Pack '${pack.id}' download failed (status=${status.status}, reason=${status.reason}).`
      );
    }
    // 'pending' | 'running' | 'paused' → keep polling.
  }

  if (pack.sha256 && bridge.verifyPackArchive) {
    const verify = await bridge.verifyPackArchive(
      archivePath,
      pack.sha256,
      pack.approxSizeBytes ?? -1
    );
    if (!verify.ok) {
      throw new Error(verify.error || `Pack '${pack.id}' archive failed integrity check.`);
    }
  }

  return bridge.extractPackArchive(pack.id, archivePath, pack.tools);
}
