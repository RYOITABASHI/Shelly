import {
  cleanupLegacyUpdateDirs,
  cleanupReleaseApks,
  describeCleanupResult,
  isReleaseApkFileName,
  legacyDirContentsRemovable,
  releaseApkVersionCode,
  selectStaleApksBeforeDownload,
  selectStaleApksOnStartup,
  selectStaleLegacyUpdateDirs,
  type CleanupBridge,
} from '@/lib/release-apk-cleanup';

const DIR = '/storage/emulated/0/Android/data/dev.shelly.terminal/files/Download';
const apk = (vc: number, ver = '6.0.0') => `Shelly-android-v${ver}-${vc}-27992037105-1-102ef615eb13.apk`;

describe('release APK name parsing', () => {
  it('recognizes release asset names only', () => {
    expect(isReleaseApkFileName(apk(2700))).toBe(true);
    expect(isReleaseApkFileName('Shelly-android-anything.apk')).toBe(true);
    expect(isReleaseApkFileName('packs')).toBe(false);
    expect(isReleaseApkFileName('other.apk')).toBe(false);
    expect(isReleaseApkFileName('Shelly-2700-new-signing-key.apk')).toBe(false);
    expect(isReleaseApkFileName('Shelly-android-x.apk.part')).toBe(false);
    expect(isReleaseApkFileName('../Shelly-android-x.apk')).toBe(false);
    expect(isReleaseApkFileName('sub/Shelly-android-x.apk')).toBe(false);
  });

  it('extracts the versionCode', () => {
    expect(releaseApkVersionCode(apk(2700))).toBe(2700);
    expect(releaseApkVersionCode(apk(1388, '5.3.8'))).toBe(1388);
    expect(releaseApkVersionCode('Shelly-android-anything.apk')).toBeNull();
  });
});

describe('selectStaleApksBeforeDownload', () => {
  it('deletes every other release APK but keeps the target', () => {
    const names = [apk(2600), apk(2650), apk(2700), 'packs', 'notes.txt', 'ShellyModels'];
    expect(selectStaleApksBeforeDownload(names, apk(2700))).toEqual([apk(2600), apk(2650)]);
  });

  it('keeps protected (handed-off / in-flight) files, given as paths', () => {
    const names = [apk(2600), apk(2650), apk(2700)];
    expect(selectStaleApksBeforeDownload(names, apk(2700), [`${DIR}/${apk(2650)}`, null, undefined])).toEqual([
      apk(2600),
    ]);
  });
});

describe('selectStaleApksOnStartup', () => {
  it('deletes APKs at or below the installed versionCode only', () => {
    const names = [apk(2600), apk(2700), apk(2701), 'Shelly-android-odd.apk', 'packs'];
    expect(selectStaleApksOnStartup(names, 2700)).toEqual([apk(2600), apk(2700)]);
  });

  it('respects protected paths and refuses an unknown installed version', () => {
    const names = [apk(2600), apk(2650)];
    expect(selectStaleApksOnStartup(names, 2700, [`${DIR}/${apk(2600)}`])).toEqual([apk(2650)]);
    expect(selectStaleApksOnStartup(names, NaN)).toEqual([]);
    expect(selectStaleApksOnStartup(names, 0)).toEqual([]);
  });
});

describe('legacy shelly-update dirs', () => {
  it('selects only old shelly-update-* dirs', () => {
    const names = ['shelly-update-1500', 'shelly-update-android-latest-2600', 'shelly-update-2800', 'shelly-apk', 'ShellyModels', 'shelly-update-'];
    expect(selectStaleLegacyUpdateDirs(names, 2700)).toEqual(['shelly-update-1500', 'shelly-update-android-latest-2600']);
  });

  it('only removes dirs that hold nothing but apk files', () => {
    expect(legacyDirContentsRemovable([{ name: 'a.apk', isDirectory: false }])).toBe(true);
    expect(legacyDirContentsRemovable([])).toBe(true);
    expect(legacyDirContentsRemovable([{ name: 'a.apk', isDirectory: false }, { name: 'x.txt', isDirectory: false }])).toBe(false);
    expect(legacyDirContentsRemovable([{ name: 'sub.apk', isDirectory: true }])).toBe(false);
  });
});

function fakeBridge(opts: {
  apks?: string[];
  legacy?: { name: string; entries: { name: string; isDirectory: boolean }[] }[];
  failDelete?: string[];
  throwList?: boolean;
}) {
  const deletedApks: string[] = [];
  const deletedDirs: string[] = [];
  const bridge: CleanupBridge = {
    listReleaseApks: jest.fn(async () => {
      if (opts.throwList) throw new Error('boom');
      return [...(opts.apks ?? [])];
    }),
    deleteReleaseApk: jest.fn(async (name: string) => {
      if (opts.failDelete?.includes(name)) throw new Error('EACCES');
      deletedApks.push(name);
      return true;
    }),
    listLegacyUpdateDirs: jest.fn(async () => opts.legacy ?? []),
    deleteLegacyUpdateDir: jest.fn(async (name: string) => {
      deletedDirs.push(name);
      return true;
    }),
  };
  return { bridge, deletedApks, deletedDirs };
}

describe('cleanupReleaseApks (native bridge)', () => {
  it('lists, selects and deletes via the native methods, reporting counts', async () => {
    const { bridge, deletedApks } = fakeBridge({ apks: [apk(2600), apk(2789), apk(2800)] });
    const r = await cleanupReleaseApks(bridge, (names) => selectStaleApksOnStartup(names, 2789));
    expect(deletedApks).toEqual([apk(2600), apk(2789)]);
    expect(r).toEqual({ found: 3, selected: 2, deleted: [apk(2600), apk(2789)], errors: [] });
    expect(describeCleanupResult('startup', r)).toBe('startup: found=3 selected=2 deleted=2');
  });

  it('never passes unsafe names to the native delete even if a selector returns them', async () => {
    const { bridge } = fakeBridge({ apks: [apk(2600)] });
    const r = await cleanupReleaseApks(bridge, () => [apk(2600), '../x.apk', 'packs', 'sub/Shelly-android-x.apk']);
    expect(bridge.deleteReleaseApk).toHaveBeenCalledTimes(1);
    expect(bridge.deleteReleaseApk).toHaveBeenCalledWith(apk(2600));
    expect(r.deleted).toEqual([apk(2600)]);
  });

  it('records per-file errors without throwing and keeps going', async () => {
    const { bridge, deletedApks } = fakeBridge({ apks: [apk(2600), apk(2650)], failDelete: [apk(2600)] });
    const r = await cleanupReleaseApks(bridge, (names) => names);
    expect(deletedApks).toEqual([apk(2650)]);
    expect(r.errors).toEqual([`${apk(2600)}: EACCES`]);
    expect(describeCleanupResult('x', r)).toContain('errors=1');
  });

  it('reports listing errors and missing native methods', async () => {
    const { bridge } = fakeBridge({ throwList: true });
    const r = await cleanupReleaseApks(bridge, (n) => n);
    expect(r.errors).toEqual(['list: boom']);
    const old = await cleanupReleaseApks({}, (n) => n);
    expect(old.unsupported).toBe(true);
    expect(describeCleanupResult('x', old)).toContain('unavailable');
  });

  it('does not call delete when nothing is selected', async () => {
    const { bridge } = fakeBridge({ apks: [apk(2800)] });
    const r = await cleanupReleaseApks(bridge, (names) => selectStaleApksOnStartup(names, 2789));
    expect(bridge.deleteReleaseApk).not.toHaveBeenCalled();
    expect(r).toEqual({ found: 1, selected: 0, deleted: [], errors: [] });
  });
});

describe('cleanupLegacyUpdateDirs (native bridge)', () => {
  it('removes old apk-only dirs and leaves everything else', async () => {
    const { bridge, deletedDirs } = fakeBridge({
      legacy: [
        { name: 'shelly-update-1500', entries: [{ name: apk(1500), isDirectory: false }] },
        { name: 'shelly-update-1600', entries: [{ name: 'keep.txt', isDirectory: false }] },
        { name: 'shelly-update-1700', entries: [{ name: 'nested.apk', isDirectory: true }] },
        { name: 'shelly-update-2800', entries: [{ name: apk(2800), isDirectory: false }] },
        { name: 'ShellyModels', entries: [] },
      ],
    });
    const r = await cleanupLegacyUpdateDirs(bridge, 2700);
    expect(deletedDirs).toEqual(['shelly-update-1500']);
    expect(r).toEqual({ found: 5, selected: 1, deleted: ['shelly-update-1500'], errors: [] });
  });

  it('is a no-op on an old native build', async () => {
    const r = await cleanupLegacyUpdateDirs({}, 2700);
    expect(r.unsupported).toBe(true);
  });
});
