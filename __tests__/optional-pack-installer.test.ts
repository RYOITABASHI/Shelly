/**
 * lib/optional-pack-installer.ts — download/verify/extract orchestration for
 * `shelly install <pack>` (Fable5 roadmap item #6). Exercised against a
 * fully mocked native bridge so this suite never touches Android
 * DownloadManager or the filesystem; it only proves the JS-side state
 * machine (enqueue → poll → verify (if a sha256 is known) → extract) does
 * the right thing for each outcome, and that an unpublished pack is refused
 * before any bridge call happens at all.
 */
import {
  installOptionalPack,
  PackNotPublishedError,
  type OptionalPackLike,
  type PackDownloadStatus,
  type PackNativeBridge,
} from '@/lib/optional-pack-installer';

function basePack(overrides: Partial<OptionalPackLike> = {}): OptionalPackLike {
  return {
    id: 'test-pack',
    tools: ['footool', 'bartool'],
    archiveAssetName: 'shelly-pack-test-pack-arm64.tar.gz',
    downloadUrl: 'https://example.invalid/shelly-pack-test-pack-arm64.tar.gz',
    sha256: null,
    approxSizeBytes: null,
    published: true,
    ...overrides,
  };
}

function statusOf(status: PackDownloadStatus['status'], extra: Partial<PackDownloadStatus> = {}): PackDownloadStatus {
  return { status, reason: 0, downloadedBytes: 0, totalBytes: 0, ...extra };
}

describe('installOptionalPack — publication gate', () => {
  it('refuses an unpublished pack without calling the bridge at all', async () => {
    const bridge: PackNativeBridge = {
      enqueuePackDownload: jest.fn(),
      getApkDownloadStatus: jest.fn(),
      removeApkDownload: jest.fn(),
      extractPackArchive: jest.fn(),
    };
    const pack = basePack({ published: false });

    await expect(installOptionalPack(pack, bridge)).rejects.toBeInstanceOf(PackNotPublishedError);
    expect(bridge.enqueuePackDownload).not.toHaveBeenCalled();
  });
});

describe('installOptionalPack — missing native extraction support', () => {
  it('throws a clear error when extractPackArchive is not implemented on the bridge', async () => {
    const bridge: PackNativeBridge = {
      enqueuePackDownload: jest.fn(),
      getApkDownloadStatus: jest.fn(),
      removeApkDownload: jest.fn(),
      // extractPackArchive intentionally omitted
    };
    const pack = basePack();

    await expect(installOptionalPack(pack, bridge)).rejects.toThrow(/not supported/i);
    expect(bridge.enqueuePackDownload).not.toHaveBeenCalled();
  });
});

describe('installOptionalPack — happy path', () => {
  it('enqueues, polls through pending/running to successful, skips verify with no sha256, then extracts', async () => {
    const enqueuePackDownload = jest.fn(async () => ({ downloadId: 42, path: '/fake/archive.tar.gz' }));
    const getApkDownloadStatus = jest
      .fn<Promise<PackDownloadStatus>, [number]>()
      .mockResolvedValueOnce(statusOf('pending'))
      .mockResolvedValueOnce(statusOf('running'))
      .mockResolvedValueOnce(statusOf('successful'));
    const removeApkDownload = jest.fn(async () => undefined);
    const verifyPackArchive = jest.fn();
    const extractPackArchive = jest.fn(async () => ({
      extractedPaths: ['/fake/libDir/packs/test-pack/footool'],
      libDir: '/fake/libDir/packs/test-pack',
    }));

    const bridge: PackNativeBridge = {
      enqueuePackDownload,
      getApkDownloadStatus,
      removeApkDownload,
      verifyPackArchive,
      extractPackArchive,
    };
    const pack = basePack();

    const result = await installOptionalPack(pack, bridge, { pollIntervalMs: 0 });

    expect(enqueuePackDownload).toHaveBeenCalledWith(pack.downloadUrl, pack.id, pack.archiveAssetName);
    expect(getApkDownloadStatus).toHaveBeenCalledTimes(3);
    expect(verifyPackArchive).not.toHaveBeenCalled();
    expect(extractPackArchive).toHaveBeenCalledWith(pack.id, '/fake/archive.tar.gz', pack.tools);
    expect(result.libDir).toBe('/fake/libDir/packs/test-pack');
    expect(removeApkDownload).not.toHaveBeenCalled();
  });

  it('verifies the archive when the manifest has a known sha256, and fails closed on mismatch', async () => {
    const enqueuePackDownload = jest.fn(async () => ({ downloadId: 7, path: '/fake/archive.tar.gz' }));
    const getApkDownloadStatus = jest.fn(async () => statusOf('successful'));
    const removeApkDownload = jest.fn(async () => undefined);
    const verifyPackArchive = jest.fn(async () => ({
      ok: false,
      actualSha256: 'deadbeef',
      bytes: 123,
      error: 'sha256 mismatch',
    }));
    const extractPackArchive = jest.fn();

    const bridge: PackNativeBridge = {
      enqueuePackDownload,
      getApkDownloadStatus,
      removeApkDownload,
      verifyPackArchive,
      extractPackArchive,
    };
    const pack = basePack({ sha256: 'a'.repeat(64), approxSizeBytes: 1000 });

    await expect(installOptionalPack(pack, bridge, { pollIntervalMs: 0 })).rejects.toThrow(/sha256 mismatch/);
    expect(verifyPackArchive).toHaveBeenCalledWith('/fake/archive.tar.gz', pack.sha256, 1000);
    expect(extractPackArchive).not.toHaveBeenCalled();
  });
});

describe('installOptionalPack — failure handling', () => {
  it('removes the download and throws when DownloadManager reports failed', async () => {
    const enqueuePackDownload = jest.fn(async () => ({ downloadId: 1, path: '/fake/archive.tar.gz' }));
    const getApkDownloadStatus = jest.fn(async () => statusOf('failed', { reason: 1006 }));
    const removeApkDownload = jest.fn(async () => undefined);
    const extractPackArchive = jest.fn();

    const bridge: PackNativeBridge = {
      enqueuePackDownload,
      getApkDownloadStatus,
      removeApkDownload,
      extractPackArchive,
    };
    const pack = basePack();

    await expect(installOptionalPack(pack, bridge, { pollIntervalMs: 0 })).rejects.toThrow(/download failed/i);
    expect(removeApkDownload).toHaveBeenCalledWith(1);
    expect(extractPackArchive).not.toHaveBeenCalled();
  });

  it('times out and removes the download after maxPolls without reaching a terminal status', async () => {
    const enqueuePackDownload = jest.fn(async () => ({ downloadId: 9, path: '/fake/archive.tar.gz' }));
    const getApkDownloadStatus = jest.fn(async () => statusOf('running'));
    const removeApkDownload = jest.fn(async () => undefined);
    const extractPackArchive = jest.fn();

    const bridge: PackNativeBridge = {
      enqueuePackDownload,
      getApkDownloadStatus,
      removeApkDownload,
      extractPackArchive,
    };
    const pack = basePack();

    await expect(
      installOptionalPack(pack, bridge, { pollIntervalMs: 0, maxPolls: 3 })
    ).rejects.toThrow(/timed out/i);
    expect(getApkDownloadStatus).toHaveBeenCalledTimes(3);
    expect(removeApkDownload).toHaveBeenCalledWith(9);
    expect(extractPackArchive).not.toHaveBeenCalled();
  });
});
