/**
 * lib/optional-pack-installer.ts — download + verify + extract for `shelly install <pack>`.
 *
 * Fable5 roadmap item #6 (on-demand optional-tool packs). Driven by the
 * `$HOME/bin/shelly` shim through app/_layout.tsx's command-queue bridge
 * (and by the legacy lib/pseudo-shell.ts handler). Reuses the Android
 * DownloadManager path the in-app updater uses (`setDestinationInExternalFilesDir`)
 * via these native bridge methods:
 *
 *   - `enqueuePackDownload` — targets Download/packs/<fileName>.
 *   - `getApkDownloadStatus` / `removeApkDownload` — generic, keyed by
 *     downloadId. `removeApkDownload` also deletes the downloaded file, so it
 *     is called after every install attempt to leave no archive behind.
 *   - `verifyPackArchive` — exact size + sha256 check (fast fail).
 *   - `extractPackArchive` — LibExtractor.extractPack(): copies the archive
 *     into app-private storage, re-verifies that copy against the same pin,
 *     rejects unsafe tar entries (absolute paths, `..`, links, devices),
 *     extracts into a staging dir, checks every declared tool is present,
 *     then swaps it in atomically (a failed install never damages a working
 *     one).
 *
 * Integrity is mandatory (2026-10-29): a pack installs only when this build
 * carries a pinned sha256 for it (lib/optional-packs.ts) and the native
 * verifier is present. There is no "skip verification" path any more.
 *
 * Installed binaries land under $SHELLY_LIB_DIR/packs/<packId>/ and are
 * resolved at call time by HomeInitializer.kt's wrappers
 * (`__shelly_tool_path`), so they work immediately, even in open tabs.
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
    tools: string[],
    expectedSha256: string,
    expectedSizeBytes: number
  ) => Promise<{ extractedPaths: string[]; libDir: string }>;
};

export class PackNotPublishedError extends Error {
  constructor(packId: string) {
    super(
      `Pack '${packId}' cannot be installed by this build: it has no pinned, verified archive ` +
        '(local, development and pull-request builds carry no pack pins). ' +
        'Install a Shelly release build to use `shelly install`.'
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

// android.app.DownloadManager PAUSED_* reasons.
const PAUSED_WAITING_TO_RETRY = 1;
const PAUSED_WAITING_FOR_NETWORK = 2;
const PAUSED_QUEUED_FOR_WIFI = 3;
// android.app.DownloadManager ERROR_* reasons (HTTP status codes pass through as-is).
const ERROR_INSUFFICIENT_SPACE = 1006;
const ERROR_DEVICE_NOT_FOUND = 1007;
const ERROR_TOO_MANY_REDIRECTS = 1005;
const ERROR_HTTP_DATA_ERROR = 1004;
const ERROR_CANNOT_RESUME = 1008;

/** Human-readable explanation for a DownloadManager failure. Exported for tests. */
export function describeDownloadFailure(packId: string, status: PackDownloadStatus): string {
  const r = status.reason;
  if (r === 404 || r === 410) {
    return (
      `Pack '${packId}' archive is no longer on the server (HTTP ${r}). ` +
      'This build pins an archive that has since been pruned; update Shelly and try again.'
    );
  }
  if (r >= 400 && r < 600) {
    return `Pack '${packId}' download failed: the server answered HTTP ${r}. Try again later.`;
  }
  if (r === ERROR_INSUFFICIENT_SPACE || r === ERROR_DEVICE_NOT_FOUND) {
    return `Pack '${packId}' download failed: not enough free storage on the device.`;
  }
  if (r === ERROR_HTTP_DATA_ERROR || r === ERROR_CANNOT_RESUME || r === ERROR_TOO_MANY_REDIRECTS) {
    return `Pack '${packId}' download failed: the connection was interrupted. Check your network and try again.`;
  }
  return `Pack '${packId}' download failed (status=${status.status}, reason=${r}).`;
}

export type InstallOptionalPackOptions = {
  /** Poll interval while waiting on the DownloadManager status, ms. Default 1000. */
  pollIntervalMs?: number;
  /** Max polls before giving up as a timeout. Default 1080 (~18 min at 1s, inside the shim's 20 min wait). */
  maxPolls?: number;
  /**
   * Consecutive polls the download may sit in "waiting for network" before
   * failing as offline. Default 20 (~20 s at 1s).
   */
  offlinePolls?: number;
};

/**
 * Downloads, verifies and extracts one optional pack. Throws an Error with a
 * user-facing message on any failure; the caller prints it verbatim.
 */
export async function installOptionalPack(
  pack: OptionalPackLike,
  bridge: PackNativeBridge,
  options: InstallOptionalPackOptions = {}
): Promise<{ extractedPaths: string[]; libDir: string }> {
  if (!pack.published || !pack.sha256 || !pack.approxSizeBytes || pack.approxSizeBytes <= 0) {
    throw new PackNotPublishedError(pack.id);
  }
  if (typeof bridge.extractPackArchive !== 'function' || typeof bridge.verifyPackArchive !== 'function') {
    throw new Error(
      'Pack installation is not supported by this build of Shelly (missing native verify/extract support). Update Shelly and try again.'
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
  const cleanup = () => bridge.removeApkDownload(downloadId).catch(() => undefined);

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPolls = options.maxPolls ?? 1080;
  const offlinePolls = options.offlinePolls ?? 20;
  let polls = 0;
  let waitingForNetwork = 0;
  try {
    while (true) {
      if (polls >= maxPolls) {
        throw new Error(`Pack '${pack.id}' download timed out. Check your network and try again.`);
      }
      polls += 1;
      await sleep(pollIntervalMs);
      const status = await bridge.getApkDownloadStatus(downloadId);
      if (status.status === 'successful') break;
      if (TERMINAL_STATUSES.has(status.status)) {
        throw new Error(describeDownloadFailure(pack.id, status));
      }
      if (
        status.status === 'paused' &&
        (status.reason === PAUSED_WAITING_FOR_NETWORK ||
          status.reason === PAUSED_QUEUED_FOR_WIFI ||
          status.reason === PAUSED_WAITING_TO_RETRY)
      ) {
        waitingForNetwork += 1;
        if (waitingForNetwork >= offlinePolls) {
          throw new Error(
            `Pack '${pack.id}' needs a network connection to download and the device appears to be offline. ` +
              'Tools that are already installed keep working offline; connect and run the command again.'
          );
        }
      } else {
        waitingForNetwork = 0;
      }
    }

    const verify = await bridge.verifyPackArchive(archivePath, pack.sha256, pack.approxSizeBytes);
    if (!verify.ok) {
      throw new Error(
        `Pack '${pack.id}' archive failed its integrity check (${verify.error || 'sha256 mismatch'}); nothing was installed.`
      );
    }

    // The native side re-verifies its own private copy (authoritative); the
    // check above just fails fast before copying.
    return await bridge.extractPackArchive(pack.id, archivePath, pack.tools, pack.sha256, pack.approxSizeBytes);
  } finally {
    // Success or failure, drop the DownloadManager row and the archive file.
    await cleanup();
  }
}
