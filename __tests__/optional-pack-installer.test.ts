/**
 * lib/optional-pack-installer.ts — download/verify/extract orchestration for
 * `shelly install <pack>` (Fable5 roadmap item #6). Exercised against a
 * fully mocked native bridge so this suite never touches Android
 * DownloadManager or the filesystem; it proves the JS-side state machine
 * (enqueue → poll → mandatory sha256 verify → extract → cleanup) does the
 * right thing for each outcome, and that an unpinned pack is refused before
 * any bridge call happens at all.
 */
import {
  describeDownloadFailure,
  installOptionalPack,
  PackNotPublishedError,
  type OptionalPackLike,
  type PackDownloadStatus,
  type PackNativeBridge,
} from '@/lib/optional-pack-installer';

const SHA = 'a'.repeat(64);

function basePack(overrides: Partial<OptionalPackLike> = {}): OptionalPackLike {
  return {
    id: 'test-pack',
    tools: ['footool', 'bartool'],
    archiveAssetName: 'shelly-pack-test-pack-arm64-aaaaaaaaaaaaaaaa.tar.gz',
    downloadUrl: 'https://example.invalid/shelly-pack-test-pack-arm64-aaaaaaaaaaaaaaaa.tar.gz',
    sha256: SHA,
    approxSizeBytes: 1000,
    published: true,
    ...overrides,
  };
}

function statusOf(status: PackDownloadStatus['status'], extra: Partial<PackDownloadStatus> = {}): PackDownloadStatus {
  return { status, reason: 0, downloadedBytes: 0, totalBytes: 0, ...extra };
}

function okVerify() {
  return jest.fn(async () => ({ ok: true, actualSha256: SHA, bytes: 1000, error: null }));
}

function bridgeWith(overrides: Partial<PackNativeBridge> = {}): PackNativeBridge {
  return {
    enqueuePackDownload: jest.fn(async () => ({ downloadId: 42, path: '/fake/archive.tar.gz' })),
    getApkDownloadStatus: jest.fn(async () => statusOf('successful')),
    removeApkDownload: jest.fn(async () => undefined),
    verifyPackArchive: okVerify(),
    extractPackArchive: jest.fn(async () => ({
      extractedPaths: ['/fake/libDir/packs/test-pack/footool'],
      libDir: '/fake/libDir/packs/test-pack',
    })),
    ...overrides,
  };
}

describe('installOptionalPack — publication / pin gate', () => {
  it.each([
    ['unpublished', { published: false }],
    ['no sha256 pin', { sha256: null }],
    ['no pinned size', { approxSizeBytes: null }],
  ])('refuses a pack with %s without calling the bridge at all', async (_label, overrides) => {
    const bridge = bridgeWith();
    await expect(installOptionalPack(basePack(overrides), bridge)).rejects.toBeInstanceOf(PackNotPublishedError);
    expect(bridge.enqueuePackDownload).not.toHaveBeenCalled();
  });
});

describe('installOptionalPack — missing native support', () => {
  it.each(['extractPackArchive', 'verifyPackArchive'] as const)(
    'throws a clear error when %s is not implemented on the bridge',
    async (missing) => {
      const bridge = bridgeWith();
      delete (bridge as any)[missing];
      await expect(installOptionalPack(basePack(), bridge)).rejects.toThrow(/not supported/i);
      expect(bridge.enqueuePackDownload).not.toHaveBeenCalled();
    }
  );
});

describe('installOptionalPack — happy path', () => {
  it('enqueues, polls to successful, verifies the pinned sha256 + size, extracts, then removes the download', async () => {
    const getApkDownloadStatus = jest
      .fn<Promise<PackDownloadStatus>, [number]>()
      .mockResolvedValueOnce(statusOf('pending'))
      .mockResolvedValueOnce(statusOf('running'))
      .mockResolvedValueOnce(statusOf('successful'));
    const bridge = bridgeWith({ getApkDownloadStatus });
    const pack = basePack();

    const result = await installOptionalPack(pack, bridge, { pollIntervalMs: 0 });

    expect(bridge.enqueuePackDownload).toHaveBeenCalledWith(pack.downloadUrl, pack.id, pack.archiveAssetName);
    expect(getApkDownloadStatus).toHaveBeenCalledTimes(3);
    expect(bridge.verifyPackArchive).toHaveBeenCalledWith('/fake/archive.tar.gz', SHA, 1000);
    expect(bridge.extractPackArchive).toHaveBeenCalledWith(pack.id, '/fake/archive.tar.gz', pack.tools, SHA, 1000);
    expect(result.libDir).toBe('/fake/libDir/packs/test-pack');
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
  });
});

describe('installOptionalPack — failure handling', () => {
  it('fails closed on a sha256 mismatch: no extraction, download removed', async () => {
    const bridge = bridgeWith({
      verifyPackArchive: jest.fn(async () => ({ ok: false, actualSha256: 'dead', bytes: 1000, error: 'sha256 mismatch' })),
    });
    await expect(installOptionalPack(basePack(), bridge, { pollIntervalMs: 0 })).rejects.toThrow(
      /integrity check \(sha256 mismatch\); nothing was installed/
    );
    expect(bridge.extractPackArchive).not.toHaveBeenCalled();
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
  });

  it('removes the download and explains a storage failure', async () => {
    const bridge = bridgeWith({ getApkDownloadStatus: jest.fn(async () => statusOf('failed', { reason: 1006 })) });
    await expect(installOptionalPack(basePack(), bridge, { pollIntervalMs: 0 })).rejects.toThrow(/not enough free storage/);
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
    expect(bridge.extractPackArchive).not.toHaveBeenCalled();
  });

  it('explains a pruned (404) archive as "update Shelly"', async () => {
    const bridge = bridgeWith({ getApkDownloadStatus: jest.fn(async () => statusOf('failed', { reason: 404 })) });
    await expect(installOptionalPack(basePack(), bridge, { pollIntervalMs: 0 })).rejects.toThrow(/update Shelly/);
  });

  it('fails fast as offline when DownloadManager keeps waiting for network', async () => {
    const getApkDownloadStatus = jest.fn(async () => statusOf('paused', { reason: 2 }));
    const bridge = bridgeWith({ getApkDownloadStatus });
    await expect(
      installOptionalPack(basePack(), bridge, { pollIntervalMs: 0, offlinePolls: 3 })
    ).rejects.toThrow(/appears to be offline.*already installed keep working offline/);
    expect(getApkDownloadStatus).toHaveBeenCalledTimes(3);
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
  });

  it('resets the offline counter once the download makes progress', async () => {
    const getApkDownloadStatus = jest
      .fn<Promise<PackDownloadStatus>, [number]>()
      .mockResolvedValueOnce(statusOf('paused', { reason: 2 }))
      .mockResolvedValueOnce(statusOf('paused', { reason: 2 }))
      .mockResolvedValueOnce(statusOf('running'))
      .mockResolvedValueOnce(statusOf('paused', { reason: 2 }))
      .mockResolvedValueOnce(statusOf('paused', { reason: 2 }))
      .mockResolvedValueOnce(statusOf('successful'));
    const bridge = bridgeWith({ getApkDownloadStatus });
    await expect(installOptionalPack(basePack(), bridge, { pollIntervalMs: 0, offlinePolls: 3 })).resolves.toBeDefined();
  });

  it('times out and removes the download after maxPolls without reaching a terminal status', async () => {
    const getApkDownloadStatus = jest.fn(async () => statusOf('running'));
    const bridge = bridgeWith({ getApkDownloadStatus });
    await expect(
      installOptionalPack(basePack(), bridge, { pollIntervalMs: 0, maxPolls: 3 })
    ).rejects.toThrow(/timed out/i);
    expect(getApkDownloadStatus).toHaveBeenCalledTimes(3);
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
    expect(bridge.extractPackArchive).not.toHaveBeenCalled();
  });

  it('removes the download when extraction itself fails', async () => {
    const bridge = bridgeWith({
      extractPackArchive: jest.fn(async () => {
        throw new Error("pack 'test-pack' archive is missing: bartool");
      }),
    });
    await expect(installOptionalPack(basePack(), bridge, { pollIntervalMs: 0 })).rejects.toThrow(/missing: bartool/);
    expect(bridge.removeApkDownload).toHaveBeenCalledWith(42);
  });
});

describe('describeDownloadFailure', () => {
  it('falls back to the raw status for unknown reasons', () => {
    expect(describeDownloadFailure('p', statusOf('failed', { reason: 1000 }))).toMatch(/status=failed, reason=1000/);
  });
  it('maps other HTTP errors to a retry hint', () => {
    expect(describeDownloadFailure('p', statusOf('failed', { reason: 503 }))).toMatch(/HTTP 503/);
  });
});
